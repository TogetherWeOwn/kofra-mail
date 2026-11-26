# M3 outbound: build plan

Status: plan, version 5. The open review items from the contract review are resolved here (sweeper registration, quota release lists, the folder version for self-delivery, late confirmations), and so are the version 2 review findings (internal handoffs as parents of single-mailbox deliveries, one-statement sender checks, frozen MIME inputs, stored provider results, timer ordering). It depends on the Mail API contract in `contracts/mail-api`. It implements the send half of the [Mail API contract](../contracts/mail-api/README.md) (`sendDraft`, `undoSend`, `getSend`, `listSends`, drafts and uploads) on Cloudflare Email Sending.

**Model routing:**
- **Opus** builds the send-path durability, concurrency and authorisation code.
- **Sol** builds the routine parts, and Opus reviews them.
- **Every T0 package gets two independent reviews:** a general review (Sol) and a security review (Opus, high effort). Section 5 is the security checklist.

## 1. Global rules

- **Off by default.** The send path runs only with `MAIL_SEND_ENABLED=on`. Tests use a fake `EMAIL` binding that records calls.
- **No live sends** except in M3-0 and M3-12, and only to the approved test route's addresses. No production deploy, no new spend, and no DNS or suppression-list writes.
- **The mailbox Durable Object owns all send state.** The `send` queue carries two message kinds, both ids only and far below the 128 KB limit: a **dispatch** message `{ kind: 'dispatch', ws, mb, sendId }`, and a **result notice** `{ kind: 'result', ws, mb, sendId, fence }` that only says a stored provider result is waiting (section 2.4, consumer step 6). A result notice never leads to a `send()` call.
- **Directory checks are one statement.** Every check of a send's sender (at release, at each claim, at `authorizeDispatch` and in the internal handoff) is one indexed, primary-consistent directory statement that requires, together, the workspace, the mailbox, the submitting user as its owner and `from` as an active identity of that mailbox. Two separate reads could combine states that were never true at the same time.
- **No content in logs or alerts:** no message content, subjects or addresses. Addresses appear only as counts or as the first 8 characters of a SHA-256.
- **Send state is journalled, and published before it matters.** `sends` rows, ledger changes and each sent copy's index row (raw key, flags, labels, the Bcc list) are non-derived state in the mailbox journal. Normally the journal publishes drafts and settings within 60 seconds and flags within an hour, and a restore loads the latest snapshot plus the published deltas. A send moves faster than that (the shortest undo window is 5 seconds), so the send path uses a **publish barrier** (section 2.1).
- **Restores are fenced and resume sending through timers** (section 2.5), following the inbound recovery rules: a restore raises the mailbox's recovery epoch, runs in resumable slices, and "restoring" or "not ready" never spends an attempt or ends in `failed`.
- **Stop rule for every package:** if a package needs a change to the inbound design decisions (storage keys, holder ordering, journal recovery boundary, recovery epoch), stop and write a design note for Opus. Do not adapt them locally.

## 2. Send state machine

```
sendDraft ──► pending ──(undo)──► cancelled
                │ alarm at undoUntil
                ▼
            releasing ──► queued ──► sending ──► sent | partial | failed
                              ▲          │
                              └─ delayed ◄┘  (daily quota reached: timer until reset)
```

`releasing` and `queued` are internal; the contract reports both as `sending`.

### 2.1 Publish barrier

A **publish** writes the journal delta up to the current `seq` and then the manifest whose `last_seq` covers it (conditional on the previous manifest's ETag). One publish runs per mailbox at a time; a barrier that arrives while one is in flight joins it, or waits for it and then publishes the remainder, so two barriers never race the manifest's ETag.

These steps wait for a publish that covers their own commit:

| Step | Why |
|---|---|
| `sendDraft` answers 202 | A restore cannot bring back the draft and lose an accepted send. The undo window absorbs the latency |
| `undoSend` answers 2xx | A restore cannot bring back a `pending` send the user undid, which would then go out |
| Release, before enqueue (step 4a) | A restore cannot bring back a draft whose message went out, or drop its sent copy |
| Mark, before `send()` | A restore after `send()` always finds the recipients `attempting` under the lease that bounds the call (section 2.4, step 5), so the next claim waits that lease out and counts them as ambiguous |
| Any transition to a terminal state (`sent`, `partial`, `failed`, `cancelled`) is reported or acted on | A restore cannot rewind a finished send and send it again, or revive a send the user saw fail |
| Releasing the send's object holders | A restored, not-yet-terminal send never points at deleted objects |

An idempotent replay of `sendDraft` or `undoSend` also waits until the original commit is published, so a lost response cannot hand out an unpublished result.
- **If a publish fails after `sendDraft` or `undoSend` committed,** the request answers 409 `idempotency_in_progress` with `Retry-After`, never a 5xx: the action has taken effect, and the client must retry with the same key (contract section 5). Release does not start until a publish covers the `sendDraft` event (release step 1), so nothing is registered, stored or sent for a send that a restore could still lose.
- **Inside the alarm or the consumer,** a failed publish stops the step and leaves its timer.
- **Answers report remaining time at answer time:** `undoRemainingMs = max(0, undoUntil - now)` is computed when the 202 is sent, after the publish.
- **The idempotency rows of `sendDraft` and `undoSend` are journalled** in the same event as their effect, so a retry after a restore still returns the original result.

Cost: about five journal writes per send, plus one per retry.

### 2.2 One drive timer per send

Each send has **exactly one timer row, `send_drive`**, keyed by `sendId`, from `sendDraft` until its cleanup is finished. There are no other send timer kinds.
- **Other steps only move it.** Every step below sets the row's `due_at` with an upsert on that one row; none inserts a second row or deletes it. While an internal recipient is not yet handed off, every move takes the earlier of the step's own time and the handoff's next retry, so a quota wait, a lease or a backoff of the external recipients never postpones an internal delivery. Only the end of cleanup deletes it, unconditionally, because the send is terminal and finished.
- **The handler re-arms before acting.** In one transaction it moves its own row to now + backoff, then acts on the send's state. The backoff is 5 minutes, doubling to at most 1 hour, from a `drive_backoff` field on the `sends` row. A report or a state change resets the field; a claim does not.

| State | The handler |
|---|---|
| `pending`, `now ≥ undoUntil` | starts release (section 2.4) |
| `releasing` | resumes release from the committed step |
| `queued` with an unpublished release commit | runs release step 4a, then enqueues |
| `queued`, `sending` or `delayed`, release published, an internal recipient not yet handed off | runs the internal handoff (release step 6), then the row for the external state below |
| `queued`, `sending`, every recipient terminal (internal ones included) | runs the finish rule |
| `queued`, `sending`, an external recipient not terminal | enqueues if no live lease holds the send and `now ≥ next_attempt_at` |
| `delayed`, `now ≥ delayedUntil` | sets `queued` and enqueues |
| terminal or `cancelled` with `finish_pending` | resumes the finish rule (section 2.4) |
| anything else | nothing; the row waits for its `due_at` |

  It also checks the deadline (section 2.4).
- **Every handler commit is a compare-and-set.** A handler run takes a fresh driver token, stored on the `sends` row in its first transaction, and each later commit of that run requires both the token and the state or step it started from. A run that outlived its budget, or was overtaken by a later run, may finish its remote I/O (an object PUT cannot be cancelled) but commits nothing.
- **So a lost, duplicated or dead-lettered queue message, a crash in any step, or a failed publish is always re-driven,** and two drivers can never run for one send.
- The alarm never enqueues a `cancelled` send, and the consumer re-checks the state before calling `send()`.

### 2.3 Writes from the API

**Order of checks** (contract section 5): authentication, access, re-authentication, rate limits and header presence (`Idempotency-Key`, `If-Match`) run first. A committed idempotency key then replays **before** the draft's existence or revision is checked, so a retry of a `sendDraft` whose response was lost returns the send although the draft is gone. Only on a key miss do the existence (404) and `If-Match` (412) checks run.

**`sendDraft`** runs in one Durable Object transaction, then waits for the barrier:
1. Validate the draft (contract section 8.3).
2. Insert the `sends` row as `pending`, with `dateAt = undoUntil` (the sent message's `Date`, fixed here). It points at the immutable stored draft revision and its attachment holders, and records the submitting account user, which release and every claim compare with the mailbox's owner. It also **freezes every other input of the MIME bytes**: the identity's display name, the `Reply-To` from settings, and the MIME builder's version. The boundary, our `Message-ID`, the sent copy's message id and its index holder id all derive from `sendId`. So the bytes, and the digest, depend only on the `sends` row.
3. Delete the draft row. Steps 2 and 3 are one journal event, so a restore replays both or neither.
4. Create the `send_drive` row at `undoUntil`.
5. Store the idempotency result.

**`undoSend`** runs in one transaction, only from `pending`, then waits for the barrier:
1. Set the state to `cancelled` with `finish_pending`, and move `send_drive` to now.
2. Restore the draft under its old id with a new revision (one journal event with step 1).
3. Store the idempotency result, so a retry after a lost response returns the restored draft.

### 2.4 Release, the consumer and finishing

**Release** (run by the drive handler), in order:
1. **Commit:** `pending` → `releasing`, only once a publish covers the `sendDraft` event; if none does yet, the handler publishes first and stops if that fails. The message's `Date` comes from `dateAt`, the first `undoUntil`, which `sendDraft` already published and nothing ever moves (the restore epilogue may move `undoUntil` itself, never `dateAt`), and every other input is frozen in the `sends` row (`sendDraft` step 2), so a rerun, even after a restore rewound this commit and the user changed settings or a deploy changed the builder, builds identical bytes and the content-addressed key does not change. If M3-0 shows the provider replaces `Message-ID`, the index records the delivered id for threading; the stored bytes keep ours.
2. **Re-check the owner, send-as and limits, and resolve internal recipients.** An alias may have been removed, or the mailbox given to another member, during the undo window. The owner and send-as check is the one directory statement of section 1. A send that fails it becomes `failed` with reason `invalid_sender`; one over a limit becomes `failed` with `message_too_large`; one whose source (its draft revision, or an upload or forwarded part) the sweeper's `confirm` answered `lost` becomes `failed` with `delivery_error` and raises an operator alert (section 2.7). Only a `lost` answer from `confirm` counts; a transient read or storage error retries as before. Each is a release-time failure before any handoff, under the finish rule: publish before reporting, then cleanup. That terminal commit also inserts one ledger row per recipient, internal and external, `failed` with the same reason, so `getSend` reports each recipient as the contract requires (contract section 8.3) after cleanup has released the draft. This can happen on a rerun after a crash in step 3. Any path that ends a send with no committed sent-copy index row (this failure, or `cancelled` after a restore rewound an unpublished release) releases both sent-copy holders through the step 3 **registration**, and releasing an absent holder does nothing. A directory point lookup marks each recipient whose address routes to a mailbox of this workspace as **internal**. Release records only that classification, never the destination mailbox: the handoff resolves the destination at delivery time (step 6).
3. **Store the sent copy:** build the MIME of the sent copy, then make **one sweeper call, `registerSend`,** then PUT it to object storage (holders before PUT, as on the inbound path). Every PUT carries a timeout of at most 10 minutes. `registerSend` creates the generation's ledger row before any PUT, so any object a PUT writes, even one that lands after its holders were released, sits under a ledger row that the sweeper retires after the retention grace (35 days from the last reference). The sweeper deletes only after that grace, far beyond any PUT's timeout. A run also starts a PUT only right after its own successful `registerSend` and while its driver token is current, so no delayed run can start one weeks later. As a backstop that does not depend on when storage commits a write, the sweeper deletes every retired generation **twice**, the second time 24 hours after the first, and drops its ledger row only after the second delete; an object that a late write recreated in between is removed by it. `registerSend` runs as **one sweeper transaction**: it chooses the generation (the live generation of `raw/<sha256>` if one exists, otherwise a new one, by the same rule as inbound `register`), adds both holders to it, and persists the **registration**. Because the sweeper retires only generations with no holders, and retirement is itself one sweeper transaction, a sweep either retires an unheld generation before `registerSend` (which then mints a new generation) or finds it held; a registration can never name a retired generation. The registration lives in the sweeper's own store, outside the mailbox journal, so a restore cannot rewind it. It is keyed by (workspace, mailbox, `sendId`) and records the exact generation key (`raw/<sha256>/<gen>`) and both holder ids. `registerSend` takes the digest of the built bytes. A repeat call with the same digest returns the existing record unchanged and adds nothing, so a lost reply is recovered by calling again; a repeat with a different digest is an invariant breach (stop, operator alert, no PUT), which frozen inputs make impossible. Cleanup releases through **`releaseSend(mode)`**: `all` releases both holders (no sent-copy index row was committed) and `raw` releases only the send's raw holder (a committed index row keeps its index holder until the row is gone). Either mode leaves a released tombstone for what it released, even when no registration exists yet; a registration is never reused, and a `registerSend` that arrives after its tombstone (a call still in flight from a crashed run) answers `released` and adds nothing, which release treats as the same invariant breach. The sweeper releases by (generation key, holder), and cleanup after a rewind looks both up here:
   - the sent copy's **index holder**, which belongs to its index row like any message's and, while that row exists, is released only when it is gone (expiry or deletion), never by the finish rule. With no committed index row, release step 2 or finish step 3 releases it through the registration;
   - the send's own **raw holder** `(send, sendId)`, which keeps the bytes for the internal handoff even if the sender deletes the sent copy or it expires first. The finish rule releases it, after every internal row is terminal, so a delivery's own holder has taken over by then. The stored MIME never contains a `Bcc` header; Bcc recipients live only in the `sends` row and the sender's index.
4. **Commit:** index the sent copy (`sent: true`) and insert the ledger rows, `pending`, one per recipient, each `external` or `internal`. Set `releasing` → `queued`.
4a. **Barrier:** publish up to this commit. If the publish fails, stop; the drive timer resumes here.
5. **Enqueue**, only if an external recipient is not terminal: `await SEND.send({ kind: 'dispatch', ws, mb, sendId })`.
6. **Internal handoff,** while any internal row is `pending` (M3-8), and only once the release commit is published (step 4a), the same gate as the claim: an unpublished release could still be rewound by a restore and then undone. It runs in the drive handler, never in the consumer, in any non-terminal state including `delayed`, and needs no quota and no `send()`. It writes one **handoff** record, a parent that the delivery pipeline later expands into ordinary single-mailbox deliveries; the handoff itself is never a delivery row. Holders follow the inbound order: hold first, then write.
   1. **Hold:** in the workspace sweeper, hold the raw object for the handoff holder `(handoff, <handoff key>)`, with the deterministic **handoff key** `internal:<ws>:<mb>:<sendId>` (workspace, sending mailbox, send). The send's raw holder keeps the generation live, so this hold cannot fail for a retired generation. Holders of handoffs and of internal deliveries are **tombstoned** when released rather than deleted, so a repeated hold after a release is a no-op and never resurrects a holder. A tombstone does not count in `holder_count`, and the sweeper transaction that deletes a retired generation deletes its tombstones too.
   2. **Decide and write:** one D1 statement, `INSERT OR IGNORE INTO internal_handoffs … SELECT …, CASE WHEN` the section 1 directory statement holds `THEN 'accepted' ELSE 'rejected' END`. It always writes a row for the handoff key, and the first row written is the **decision**: a later or still-in-flight insert for the same key, from an overtaken driver or after the directory changed back, is ignored. The row carries the handoff key, the raw key, the sending workspace and mailbox, the internal recipient **addresses** (not mailboxes), the sent copy's message id and its `folder_rev` **as recorded at release** (0, never re-read at handoff time). Then read the row back; it counts as this send's handoff only if its workspace, sending mailbox and raw key match this send. **`accepted`:** the message is handed off (now or earlier). **`rejected`:** the sender check failed; the internal rows end `failed` with `invalid_sender` (finish rule), and the handoff holder is released only in finish step 3, after that failure is published. A rejected row is never expanded, so no in-flight write can deliver a send whose failure was published.
   3. Commit the internal ledger rows as `sent`, meaning handed to our inbound pipeline, as `sent` means accepted for an external one (journalled; the finish rule publishes them before they are reported).

   **Expansion, at delivery time.** The delivery pipeline processes a handoff by resolving its addresses from the directory as it is then, **only among mailboxes of the sending workspace**, by the same rules as inbound mail: one delivery per mailbox even when several addresses reach it; an address that no longer routes in the sending workspace (an alias deleted meanwhile, or a domain that moved to another workspace) receives nothing, because `deleteAlias` stops delivery at once. Expansion runs in three idempotent steps, fenced by a stored **plan**:
   1. **Plan:** one D1 statement resolves the routes **inside the write**, `UPDATE internal_handoffs SET plan = (SELECT … FROM` the directory tables, joined on `internal_handoffs.workspace` of the same row (never a bound parameter), over mailboxes that exist in the directory (a deleted mailbox has no row; disabling a mailbox is not part of version 1), `…) WHERE key = ? AND decision = 'accepted' AND plan IS NULL`, then the plan is read back. Because resolution and write are one statement, the plan reflects the directory as of its own commit: a revocation or reassignment that commits before it is always seen, and the **plan commit is the routing decision point** (a change committing after it no longer recalls the message, as for an inbound message already accepted). The first plan written wins; every later or concurrent expander uses the stored plan and never its own resolution. The plan lists, per child, a resolved mailbox id or an unresolved recipient index, and every child's deterministic id in the existing delivery-id format follows from it: one per resolved mailbox, derived from (handoff key, `mailbox`, mailbox id), and one per address that resolves nowhere, derived from (handoff key, `ndn`, recipient index), so notices never collide with each other or with a mailbox child.
   2. **Hold:** take each planned child's holder on its raw object (hold before write). A non-delivery notice's bytes are built deterministically from the handoff and the recipient index, registered and stored first.
   3. **Write:** one D1 batch, conditional on the handoff's stored plan being the one just read and the handoff not yet expanded, `INSERT OR IGNORE`s every planned child as an ordinary **single-mailbox `deliveries` row** with `source = 'internal'`, marks the handoff expanded and sets its `holder_release_pending`. The pipeline then releases the handoff holder and clears the flag. Each flagged handoff also has a `release_retry_at`, and the reconciler retries the release for a bounded page of flagged handoffs with `release_retry_at <= now`, by an index on `(release_retry_at, key)`, moving each one's retry ahead with backoff in the same statement, so a workspace whose sweeper keeps failing never blocks another's. A flagged handoff is never pruned.
   A crash anywhere repeats from the stored plan with the same ids and holders, so no hold is stranded and no child appears twice. From then on every child row follows the inbound rules unchanged: its mailbox's recovery-epoch fence, completion cursor, replay after a restore, holder release after indexing, and pruning after that mailbox's backup covers it. So a recipient mailbox that restores before its backup covers the message gets it back by replay, like any inbound message. For each address that resolves nowhere, the plan's `ndn` child delivers a **non-delivery notice** to the sender's mailbox, as any mail system does after accepting a message it later cannot deliver; the ledger row stays `sent`, meaning accepted. A handoff written during an outage therefore never delivers to a mailbox that has lost the address, and an address moved to another mailbox reaches its new mailbox, as an inbound message would.

   **Handoff tombstones:** an expanded handoff stays as a tombstone, so a repeat after expansion is still ignored. It is deleted only once it has been expanded **and** 7 days have passed since both its expansion and the sender's acknowledgement mark (finish rule step 3); an unexpanded handoff, or one whose `holder_release_pending` is still set, is never deleted; a `rejected` row follows the same timing from the sender's acknowledgement mark. Before the mark a restore of the sender can still lose the `sent` ledger rows and repeat the handoff, and the tombstone makes that repeat a no-op; after the mark the rows are published and no restore can lose them. Child delivery rows are pruned by the inbound rules, independently of the handoff.

   **Stop rule:** if the directory and the handoff table are not in one database, or the decision or the plan cannot be computed inside its own write statement, stop and write a design note; do not fall back to a separate check.

   **Addresses of the sender's own mailbox stay in the handoff like any internal address,** so they too are resolved at expansion. When one resolves to the sender's mailbox, its child row is of kind **`file_sent`** and carries the sent copy's message id and the release-time `folder_rev`: instead of a second copy, it files the existing sent copy into Inbox. This is the one change to the inbound pipeline: the replay projection returns a child's kind and these two fields, and both live delivery and restore replay apply a `file_sent` row through the same conditional filing (never through `ingest`), with the same receipt; a missing sent copy makes it a no-op. Every message row has a `folder_rev` counter (non-derived, journalled with the message's folder in the same event), which every folder change increments: a move, Trash, a restore from Trash, Spam, and this filing itself. The `file_sent` row carries the `folder_rev` recorded at release, and filing happens only if the copy's current `folder_rev` still equals it, that is, nobody has changed its folder since release. A copy moved away and back (to Trash and then restored to Archive, say) has a higher `folder_rev` and stays where the user put it. This guarantee covers **published** folder changes: a change the user made within the flags recovery point (section 1) and lost to a restore is lost like any other flag change, and the filing then applies to the restored state. Filing into Inbox when release already put it there is a no-op, a repeated filing finds the version already advanced and does nothing, and a second copy is never written. This covers an alias that moved to the sender after release, whose sent copy release filed in Archive. If an address has moved from the sender to another mailbox meanwhile, that mailbox receives the message.

   A crash or a failed write between these steps leaves the rows `pending` and the drive row re-drives them, with the drive backoff. Our own outage never fails an internal recipient; a handoff still pending 24 hours after release raises the stall alert.

Every step is idempotent: the content-addressed PUT, the holder registrations (tombstoned holders included), `INSERT OR IGNORE` of ledger rows, of handoffs and of child deliveries. A crash leaves the drive row, which resumes from the committed state, so a crash can cause a second queue message, never zero, and never a second internal delivery. A crash after a hold and before its write leaves only an extra holder, which the next run reuses (same holder id) or tombstones.

**Consumer** (`mail-send` Worker), in order:
1. **Claim:** RPC `claimSend(sendId)`, one Durable Object transaction:
   - It refuses a `cancelled` or terminal send, and a send with no claimable external recipient (none `pending`, and none `attempting` under an expired lease), for example a mixed send whose external recipients are terminal while an internal handoff is still pending. The consumer acknowledges; the claim takes no lease, does not increment `attempt`, reserves nothing and leaves `send_drive` alone, and the drive handler continues the handoff. A send whose recipients are all terminal is finished by the finish rule, never claimed with an empty recipient set.
   - **Not now:**
     - the mailbox is `restoring` or not ready;
     - another live lease holds the send;
     - the release commit is not yet published;
     - the send is `delayed` with `now < delayedUntil`;
     - `now < next_attempt_at`;
     - a recipient is `attempting` under a lease that has not expired, whatever its fence. That includes a lease from before a restore: its consumer may still hold a dispatch authorization until that expiry (step 4). A lease counts as expired only at `lease_until + clockSkew` (below).
     The consumer acknowledges without throwing, so queue retries are never spent on waiting; the drive row re-drives. For a live lease, the claim moves `send_drive` to that lease's expiry.
   - **Only external recipients are claimed.** Internal recipients are handed off by the drive handler (release step 6) and never reach `send()`.
   - **On every claim** it repeats the owner and send-as check (the section 1 directory statement). A `delayed` send can wait hours, so release-time checks are not enough. A failed check applies the **grace transition** below to the non-terminal **external** recipients: unprotected ones end `failed` with `invalid_sender` (finish rule), protected ones are held; internal rows keep following the handoff. Step 4 repeats both checks just before dispatch.
   - **Otherwise:**
     - It increments the send's `attempt` counter and takes a lease of 5 minutes with **fence = (recovery epoch, attempt)**.
     - It moves `send_drive` to the lease expiry.
     - It returns the send request plus the external recipients to send to: those still `pending`, and those `attempting` under a lease that has expired. An `attempting` recipient is an **ambiguous event** (section 2.6) only if its fence is from an older recovery epoch (the authorization record is not published, so a restore cannot tell) or an authorization was recorded under its fence. Otherwise `send()` cannot have run: it is returned as `pending`, uncounted, its lease counts only toward the crash-loop cap, and the claim puts that fence on the send's release list (step 2), so its quota reservations (confirmed or not) are released, because no call used them.
   - **Crash-loop cap:** a claim whose lease expires with no report at all (no `recordResult`, `delaySend` or `abandonClaim`) while it left recipients `attempting` counts as an unfinished attempt, whether or not it was authorized. A lease that expires before Mark proves `send()` never ran, and does not count. The next claim puts that lease's fence on the release list (step 2), because its reservations belong to recipients that were never `attempting` under it.
   - **When a cap or the deadline is reached** while some recipients are still protected by the one-lease grace period (below), the claim withholds sending ("not now") and moves `send_drive` to the end of the grace period. The handler then applies the cap or the deadline. After 5 unfinished attempts in a row the send is **held**, never failed, because those crashes are ours: no further claim, `send_drive` moves 24 hours ahead each time it fires, the API still reports `sending`, and an operator alert fires once per day. The hold bounds the extra copies such crashes can cause. An operator resumes the send (the counter restarts) or ends its non-terminal external recipients `failed` with `delivery_error`.
2. **Reserve quota:** reserve the recipients in the account's quota object (M3-6). A reservation is all or nothing for the claim, and is keyed by (workspace, mailbox, `sendId`, recipient, quota day, fence); `sendId` alone is unique only within a mailbox. It is provisional: it expires by itself 2 minutes after the claim's lease expiry unless the consumer confirms it (step 3a). A late or stale reservation therefore frees itself. If the confirmation finds the reservation already expired, it reserves again under the same key. If the reservation's quota day has ended before the confirmation (a claim just before the reset, confirmed after it), the confirmation moves the charge to the current quota day in the same quota-object call, so a send is always counted in the day it can be dispatched in. If the quota is now exhausted, the consumer calls `delaySend` (Mark's recipients return to `pending`), and never sends unreserved.
     - Every attempt that may call `send()` holds its own reservation, so a retry after an ambiguous result is charged again, as it should be.
     - Only the current fence can release a reservation, through `abandonClaim`, `delaySend` or a rate-limit result under that fence. A stale consumer therefore never frees a newer attempt's charge.
     - **The quota object fences too.** It keeps, per (workspace, mailbox, `sendId`, recipient), across quota days, the newest fence it has seen, so a stale consumer cannot re-reserve on a new day after its charge was released. Older fences fall into two groups, and only the first is ever released:
       - **Never authorized:** a fence of the current recovery epoch with no authorization recorded under it, so `send()` cannot have run. Each claim appends the fences it supersedes that are in this group to a durable **release list** on the `sends` row, in the claim's own transaction. Its charge must go, and it is released by fence, whatever quota day the charge sits in (a confirmation may have moved it to a later day).
       - **Kept:** a fence with an authorization recorded, or from an older epoch (the authorization record may have been lost). Its charge stays, as an ambiguous result's does. It is never added to the release list and never blocks a new reservation.
       The consumer's step 2 makes one quota-object call that releases the reservations of every fence on the release list (releasing an absent reservation does nothing), advances the newest fence to its own, and reserves under it. So no reservation under the new fence exists while a never-authorized charge remains, and a kept charge neither stalls the retry nor is released by it. A fence leaves the release list only in Mark's commit (step 3), which runs only after that quota call succeeded, and Mark removes exactly the fences the consumer's call released. So a crash anywhere after a claim leaves nothing to forget: the next claim's consumer releases the same list again, and if no consumer comes because the send ends, finish rule step 3 drains the list. A confirmation or re-reservation under an older fence is refused, so a stalled consumer cannot recreate or confirm a charge after its recipients were reclaimed. **Releasing a fence also invalidates it** in the quota object, durably and across days, including when it is the newest fence seen: a later confirmation or reservation under a released fence is refused, so a release at finish can never be undone by a stalled consumer.
     - An ambiguous or accepted result keeps its reservation. If the quota is exhausted, RPC `delaySend(sendId, until, fence)` sets `delayed` and `delayedUntil`, moves `send_drive` to `until`, returns the recipients to `pending` and ends the lease. Then acknowledge.
3. **Mark:** one transaction that first checks, before writing anything, that the fence is current, the lease is live, the send is not terminal or `cancelled`, and every claimed recipient is still as the claim left it. If any check fails it writes nothing and answers `stale`. Otherwise, in that commit, it sets the claimed recipients to `attempting` under the fence, records the fence's recipient set in the send's **attempt history** (journalled and kept as long as the `sends` row, so a late result can still be checked after cleanup), extends the lease to 5 minutes from now (`lease_until`), and moves `send_drive` to it. Then it waits for the barrier, so the published state holds `attempting` together with this `lease_until`. No later step extends this lease, so the published `lease_until` bounds every dispatch under the fence. After the publish, Mark re-checks that the fence is still current and the lease still live.
   - **If both hold,** it answers `ok`.
   - **Otherwise** it answers `stale`. If the fence is still current it returns its recipients to `pending` (a newer fence's recipients are never touched); `send()` was never called under this fence. The attempt does not count toward the crash-loop cap. The consumer then acknowledges and never calls `send()`.
3a. **Confirm quota:** confirm the step 2 reservation, re-reserving or calling `delaySend` as step 2 describes. This and the directory statement of step 4 are the only remote waits after Mark, and all of them finish before the dispatch authorization. The consumer also builds the complete `send()` request here.
4. **Authorize:** RPC `authorizeDispatch(sendId, fence)`. It grants at most one authorization per fence, for one `send()` call.
   - The Durable Object first runs the section 1 directory statement.
   - Then, in one synchronous step with no await, it checks: the mailbox is not `restoring`; the recovery epoch and `attempt` equal the fence; no authorization was granted under this fence yet; the lease is live; the send is not terminal or `cancelled`; the owner is the submitting user and `from` is active; and every recipient of the request is still `attempting` under this fence.
   - It also refuses (`stale`) when less than `10 s + clockSkew` of the lease remains. It answers a distinct **`quota_window`** when less than `10 s + 2 × clockSkew` remains before the end of the quota day the consumer's charge is confirmed in (the quota object's clock and the consumer's backward step can each differ by up to `clockSkew`) (the consumer passes that day); no authorization is recorded. On `quota_window` the consumer does not retry at once: it calls `abandonClaim` under its current fence with `retryAfter` at the reset (as the quota object reports it) plus `clockSkew`, which returns the recipients to `pending`, releases the fence's reservation (it was never authorized) and re-arms `send_drive` for a fresh claim. The next attempt confirms after the quota object has rolled the day, so the charge moves to the new day (step 2) and every call is counted in the day it is made, with no confirm and authorize loop.
   - **If all hold,** it records on the send that this fence was authorized (a local write; it does not wait for a publish, because the published `lease_until` already bounds the call) and answers `ok` with `remainingMs = 10 s`. The dispatch window therefore ends at least `clockSkew` before `lease_until` on the authorizing object's clock.
   - **Any other answer is `stale`**, and the consumer acknowledges and never calls `send()`. With the current fence and no authorization granted under it, the recipients return to `pending` (`send()` cannot have run). Otherwise they stay `attempting`, and the next claim, after `lease_until`, counts them as ambiguous. **A failed owner or send-as check** applies the same grace transition instead: unprotected external recipients end `failed` with `invalid_sender` (finish rule), protected ones are held.
5. **Send:** the consumer reads its clock as `t0` just before calling step 4, and its dispatch deadline is `t0 + remainingMs`. Because `t0` precedes the Durable Object's check, the deadline is never later than the authorizing object's grant plus 10 s, as long as the consumer's clock does not step back during that call. Workers has no monotonic clock (`performance.now()` equals `Date.now()` there), so a backward step is part of the budget below. Because the authorization needs at least `10 s + clockSkew` of lease left, a backward step of at most `clockSkew` still starts the call before `lease_until`. Immediately after the answer, with no await between the check and the call, it calls `env.EMAIL.send(…)` only if `Date.now() < deadline`; otherwise it calls `abandonClaim` and sends nothing. A message has at most 50 recipients, so one call covers them all.
   - **Clocks:** the object that later reclaims the recipients may run on another machine (after a migration or a restore), so `lease_until` is compared across clocks there. `clockSkew` (30 s, configuration) bounds that difference: the window ends `clockSkew` before `lease_until` on the authorizing clock and a reclaim waits until `lease_until + clockSkew` on its own, so they stay apart while the consumer's backward step during one authorization stays at most `clockSkew` and, added to the reclaiming clock's lead over the authorizing clock, under `2 × clockSkew` (60 s). The bound is an assumption until M3-0 measures it; if a measured skew or step exceeds 10 s, raise `clockSkew` before M3-5 merges.
   - **What fencing guarantees:** no `send()` call under a fence *starts* after that fence's authorization deadline, and the deadline falls at least `clockSkew` before the `lease_until` that Mark published, less any backward step of the consumer's clock; since that step is at most `clockSkew`, the call still starts before `lease_until`, though possibly with less than `clockSkew` to spare. A newer claim takes the same recipients only after `lease_until + clockSkew`, including after a restore, which keeps the published `lease_until` (section 2.5). So, with clocks within `clockSkew`, a stale consumer never starts a call after a newer attempt was authorized.
   - **What it cannot guarantee:** the provider has no fencing token and no idempotency key. A call that started in time may still be delivered after a newer attempt's call, and a timed-out call may still deliver. Every such case is an ambiguous event (section 2.6), counted and capped at one extra copy each. An owner change or alias removal that commits after step 4's directory statement can still be followed by the one call that starts within that authorization's 10 seconds.
   - On a retry to a subset (after a partial failure), each recipient stays in the field it was in (To, Cc or Bcc).
   - If M3-0 shows that `send()` accepts envelope recipients separately from the visible To and Cc lists, the retry keeps the original lists visible. Otherwise the retried copy shows only the retried recipients, which is a recorded limitation.
6. **Record:** RPC `recordResult(sendId, fence, result)`. It never changes a recipient that is already terminal, with one exception, the **late confirmation** below.
   - **Late confirmation.** A confirmed provider fact (`sent` with its `messageId`, or `suppressed`) is always recorded for a recipient that was `attempting` under that fence in the published Mark state (the attempt history), and that fence was authorized or is from an older recovery epoch, even if the recipient has meanwhile ended `failed`. A recipient's reported outcome is the best confirmed fact across its fences: `sent` over `suppressed` over any failure, including a provider rejection from a later attempt, because the earlier attempt reached the provider. The ledger keeps each fence's outcome in the attempt history. The send's state is recomputed from its ledger (`failed` can become `partial` or `sent`, `partial` can become `sent`), the sent copy's `send.state` follows, and the change is published before the call answers. It never reopens sending, never recreates `send_drive`, and never touches a lease, a holder or a reservation. A fence that never had the recipient in its Mark set changes nothing for it. The metric `send_late_confirmation` rises. So a delivered recipient is reported as delivered however late its result arrives, and the post-restore hold below only shortens how long a wrong `failed` can show.
   - **The error classes** come from the M3-0 error-code receipt:
     - *Accepted:* `sent` (with `messageId`) or `suppressed`.
     - *Rejected for good* (for example an invalid address): `failed` with a reason.
     - *Not accepted, try later* (rate limit): back to `pending`, with `next_attempt_at` at the backoff. Not counted. The daily-quota error goes through `delaySend`.
     - *Ambiguous* (timeout, connection reset, an unknown 5xx): the message may have been delivered.
       - The recipients go back to `pending`, the metric `send_ambiguous_retry` rises, and the send's **provider-ambiguous count** goes up. Only these provider-reported errors count toward the cap below.
       - `next_attempt_at` is at least 30 minutes ahead, and the claim enforces it, so 3 ambiguous errors span at least an hour.
       - At 3, the remaining external recipients end `failed` with `delivery_error` (finish rule), and an alert fires.
   - **With the current fence** it records every class, ends the lease and moves `send_drive` to `next_attempt_at` (or to now, for finishing), in one transaction.
   - **With a stale fence** (a restore or a newer claim came in between) it records only `sent` and `suppressed`, because those are confirmed provider facts. It changes no lease and no timer. A stale consumer can therefore never send again, but its confirmed deliveries are kept.
   - **Whenever `recordResult` cannot complete** (the mailbox is `restoring`, or the call throws or times out, for example during a deploy), the consumer first stores the result durably in the D1 table `send_results`, keyed by (workspace, mailbox, `sendId`, fence), with recipient indexes and provider message ids only (no addresses or content), then enqueues a **result notice** and acknowledges. If that D1 write fails too, it does not acknowledge, and the queue retries the message; a result lost that way is an ambiguous event (one extra copy at most).
     - The drive handler of the send, which the restore epilogue moves to now, reads its stored results with a point lookup and records them; so does the notice. Each stored result is recorded with `recordResult`, and its row is deleted only after the publish covering it. `recordResult` is idempotent per fence: a result already recorded under a fence is acknowledged and changes nothing.
     - A notice that finds the mailbox restoring is acknowledged without re-enqueueing, and sets the row's `notify_after` to the restore's next expected slice (at least 5 minutes ahead); a notice that cannot record for another reason sets `notify_after` with backoff, doubling from 1 minute to at most 1 hour. Notices may be dropped at any point, because the stored row, not the notice, carries the fact; there is no age limit on the row while its send exists. A row is deleted with a metric only when its mailbox's directory entry is gone, or a **ready** mailbox finds no such send; a mailbox that is not ready (including a state-lost object before its restore starts) answers "not ready" and the row backs off, so a restore can still bring the send back.
     - **Independent retry path:** each row has `notify_after` (its creation plus 5 minutes at first), and the one-minute reconciler reads a bounded page of rows with `notify_after <= now`, by an index on `(notify_after, key)`, moves each one's `notify_after` ahead by its backoff in the same statement, and sends a notice for each. Rows that keep failing therefore move back in the order and never starve newer rows, so a stored result is recorded even for a send whose cleanup has finished and whose drive row is gone. `recordResult` on a finished send applies only a late confirmation, publishes, and then the row is deleted.
     - A result notice never calls `send()`.
   - **Errors before `send()`** (the quota object's RPC, Mark, building the request, `authorizeDispatch`, a missed dispatch deadline): the consumer calls `abandonClaim(sendId, fence, retryAfter)`.
     - With the current fence it returns the claimed recipients to `pending`, ends the lease, and sets `next_attempt_at` and `send_drive` to `retryAfter`, clamped to between 1 minute and 1 hour. It does not count toward any cap.
     - With a stale fence `abandonClaim` and `delaySend` do nothing.
   - **A terminal or `cancelled` send counts as stale for every fence.** Mark, `authorizeDispatch`, `delaySend`, `abandonClaim` and `recordResult` against it change no recipient, lease or timer, and never recreate `send_drive`; the only exception is a late confirmation, which changes just that recipient's ledger row and the send's reported state. Finish rule step 1 also ends any lease, so a consumer that outlived its lease cannot reopen a finished send. **The grace transition.** The caps, the deadline and a failed owner or send-as check (`invalid_sender` at a claim or an authorization) all use it. A recipient that may have been sent, one `attempting` with an authorization recorded under its fence or from an older epoch, is **protected**: it is held, and the transition moves `send_drive` to the end of its hold. The hold lasts one lease period from the later of its lease expiry and the end of the most recent restore, so a stored result delayed by the restore usually lands before the hold ends. Only unprotected recipients are failed now; a protected one is failed when its hold ends without a result, and a confirmed result that arrives after that still replaces the failure (late confirmation).
   - **A stale-fence record that moves a non-terminal send to all recipients terminal** runs finish rule step 1 itself; the drive handler does the rest. A late confirmation on an already-terminal send never enters the finish rule and never recreates `send_drive`; it only recomputes and publishes the reported state.
7. **Finish:** when every recipient is terminal, internal recipients included, the send becomes `sent`, `partial` or `failed` (finish rule), and the sent copy's `send.state` follows.

**The finish rule** applies to every terminal transition: `recordResult`, release step 2, the internal handoff, the claim's or the authorization's `invalid_sender`, the caps, the deadline, and `undoSend` (`cancelled`). **The caps and the deadline apply only to external recipients;** an internal row becomes terminal only through its handoff, so a mixed send that hits a cap still waits for its internal handoffs. Apart from `cancelled` (which comes before any ledger row exists) and the release-time failures of release step 2 (`invalid_sender`, `message_too_large`, and a confirmed `lost` source, which write their failed ledger rows, internal and external, in their terminal commit), the finish predicate is that every ledger row, internal and external, is terminal; otherwise an internal row becomes terminal only through its handoff (the release-time failures above are the only pre-handoff exceptions; a source the sweeper confirmed `lost` (section 2.7) is among them because it is data loss, not an outage), and becomes `sent` only once its handoff row exists, written after its holder. It can also end `failed` with `invalid_sender` (handoff step 2, when the decision row says `rejected`), which never expands.
1. Commit the terminal state with `finish_pending`, end any lease, and move `send_drive` to now.
2. Publish (section 2.1) before reporting the state or acting on it.
3. Release the send's own holders: both sent-copy holders, found through the release step 3 registration by (workspace, mailbox, `sendId`), if no index row for the sent copy was committed (a release that failed in step 2, possibly after an earlier run's step 3, or `cancelled` after a restore rewound it), the draft revision's, the uploads' and forwarded parts' it held (for `cancelled`, only those the restored draft no longer uses), and its raw holder (release step 3). A committed copy's index holder stays with its index row. If the send's handoff decision is `accepted`, mark it acknowledged; the pipeline releases its holder after expansion. If it is `rejected`, release the handoff holder here, tombstoned (the failure is published by step 2), and mark the row acknowledged only after the sweeper confirms the tombstone, so a rejected row can never be pruned while its holder is live and a retry always finds the decision that triggers the release. Release, in one idempotent quota-object call, every fence on the release list and the reservations of recipients that ended without an accepted or ambiguous `send()`; kept charges stay. Release the sent-copy holders through `releaseSend(all)` when no index row was committed, or `releaseSend(raw)` when one was; both tombstone even an absent registration. Each child delivery keeps the raw object through its own holder, which the inbound pipeline releases after its mailbox has indexed the message.
4. Clear `finish_pending`, clear the release list and delete `send_drive`, in one transaction.

A crash or failed publish anywhere leaves `finish_pending` and the drive row, and the handler resumes at step 2. Every step is idempotent.

**Deadline:** the send keeps a **provider-wait total**: for each rate-limit or ambiguous result recorded under the current fence, the time from that report to its `next_attempt_at`. At 72 hours of provider-wait, the remaining external recipients end `failed` with `delivery_error` (finish rule), and an alert fires.
- Only time the provider caused counts. Quota waits (`delayed`, including the provider's daily-quota error) never count either: they end at a known reset, and the monthly gate can delay a send by weeks with the operator's approval. An outage of our own services (a mailbox not ready or restoring, the queue or the consumer down, crashes) never fails a send, except a source the sweeper confirmed `lost` (section 2.7), which is data loss, not an outage.
- **Our own stalls alert instead of failing:** a send that has not reached `send()` within 24 hours of release (not counting time in `delayed`, which M3-6 alerts on separately), or whose leases expired before Mark 5 times in a row, raises an operator alert, once per day.

**Dead-letter queue:** a dead-lettered `send` message only posts a redacted alert to the alert Worker over its service binding, and is acknowledged after the alert answers 2xx. It never changes the send, because the drive row re-drives it. `failed` comes only from recorded failures, the provider-ambiguous cap, the deadline, a failed sender check, a source the sweeper confirmed `lost`, or an operator ending a held send. Our own crashes, restores and outages never fail a send, except a source the sweeper confirmed `lost` (section 2.7), which is data loss, not an outage.

### 2.5 Restores

- **Fencing:** a restore raises the mailbox's recovery epoch first, so every lease and fence from before it is stale: it can record only confirmed deliveries (section 2.4, consumer step 6), and `authorizeDispatch` refuses it. An authorization handed out before the restore stays bounded by the `lease_until` that Mark published, which the restored state keeps.
- **Epilogue:** in the transaction that finishes the restore, which is the same transaction that sets the mailbox `ready` (today a separate lifecycle write; M3-3 makes them one), every restored send that is not finished gets its `send_drive` row upserted:
  - for `pending`, at `max(undoUntil, now + undoSeconds)`, with `undoUntil` (not `dateAt`) moved to match. An undo that committed but whose publish failed (the client got 409 and retries the same key) may have been lost with the unpublished delta; the fresh window lets that retry undo the send again before it goes out;
  - at `delayedUntil` for `delayed`, or at now if an internal row is still `pending` (its handoff never waits for a quota reset);
  - at now for everything else, including terminal sends with `finish_pending`. Their queue messages may already be acknowledged.
- **Attempting recipients:** recipients restored as `attempting` stay `attempting`, with their published `lease_until`. The next claim waits until `lease_until + clockSkew` and then treats them as ambiguous; it never sends to them while an authorization from before the restore could still be used.
- **Internal recipients:** rows restored as `pending` are handed off again; the deterministic handoff key makes the repeat a no-op, and the destination is resolved at expansion as usual.
- **Reset:** the restore's reset of local state also clears every table this plan adds (`sends`, the ledger, attempt history, authorization records, release lists and every timer row except `journal_flush`), so a restore that restarts from another manifest starts clean.
- **No direct enqueue:** the epilogue never enqueues directly; the drive rows do. A crash during or after the epilogue therefore still re-drives every send.

### 2.6 Duplicate policy

`send()` has no idempotency key. This is a deliberate change from the earlier design rule that a retry sends only to recipients still `pending`.
- **A recipient receives a message at least once.** A lost message is the worse failure for personal mail.
- **At most one extra copy per ambiguous event, and at most 3 ambiguous provider errors per send.** Only provider-reported ambiguous errors count toward that cap; an ambiguous event that comes from our side (a restore, or a crash after an authorization) raises the metric and an operator alert and never fails a send, and the crash-loop hold bounds how many such events one send can have. An ambiguous event is any point where `send()` may have delivered without a recorded result: a consumer crash or a restore between `send()` and its published result, an ambiguous provider error, or a restore or lease expiry after Mark (the claim cannot tell whether an authorized call started). A crash after Mark and before an authorization is not an ambiguous event: the Durable Object records every authorization, so in the same epoch the claim knows `send()` never ran, and the crash counts only toward the crash-loop cap. After a restore that record may be lost, so every restored `attempting` recipient is treated as ambiguous (metric and alert, not the cap). A crash before Mark is not an ambiguous event. Terminal results are published before they are acknowledged, and a terminal recipient is never changed except by a late confirmation (which never sends), so a finished send is never repeated.
- Each occurrence raises the metric `send_ambiguous_retry`, so we measure how often it happens before considering anything stronger.

### 2.7 Holder registration

M3-2 takes a holder before each PUT (hold before write), then commits the mailbox row that references it: a draft revision, an upload or a forwarded part. Two paths would leave a holder that no mailbox state ever references or releases:
- **A crash between the hold and the commit.** No row exists, so nothing knows about the holder.
- **A restore that rewinds an unpublished commit.** The row is gone from the restored state, but the sweeper still has the holder.

The sweeper never selects a generation that has a holder, so such an object would be kept forever: a storage leak, not data loss, but unbounded and invisible. Inbound mail does not have it, because a restore replays every completed delivery and re-holds with the same deterministic holder id, and an index row's holder is released with the row. Sends do not have it, because `registerSend` keeps a registration outside the mailbox that cleanup looks up by `sendId`. M3-2's holders are therefore **provisional until a published state confirms them.**

**Sweeper ledger.** Each holder row has a state and an expiry: `generation_holders(key, holder, state, expires_at)`. One `state` column serves every rule: `held` (every holder before this change), `provisional`, `expired`, and the `tombstone` of sections 2.4 and M3-3. Only `held` and `provisional` count in `holder_count`. `expires_at` is set only for `provisional`, and a partial index on `(expires_at, key, holder) WHERE state = 'provisional'` serves the expiry.
- **`holdProvisional({ kind, digest } | { key }, holder)`** is one sweeper transaction with the same generation choice as `register` and `hold` (a retired generation is never chosen or held). A key must be a `raw/` or `att/` generation key; anything else, legacy `drafts/` keys included, is refused. It inserts the holder as `provisional` with `expires_at = now + PROVISIONAL_TTL`. If the holder already exists as `provisional`, it moves `expires_at` to `now + PROVISIONAL_TTL`; as `expired`, it becomes `provisional` again and `holder_count` goes up; as `held`, nothing changes; as `tombstone`, it is refused. Before committing, in the same sweeper work step, it arms the sweeper alarm, as `release` already does: the alarm moves only earlier, to `min(existing alarm, nextSweepAt())`, where `nextSweepAt()` includes the new expiry `now + PROVISIONAL_TTL`. While deletes are off, the new time is at least now + 24 hours, the off-mode daily floor. So on a ledger that already has an earlier deadline (an overdue retention candidate, or a DELETE retry), that deadline is armed, not the expiry. A provisional holder counts in `holder_count` exactly like a held one, so the object is protected from the moment the holder exists.
- **`confirm(entries)`** is one sweeper transaction per call, at most 64 entries. For each (key, holder):

  | Holder state | Result | Answer |
  |---|---|---|
  | `provisional` | becomes `held`, expiry cleared | `held` |
  | `held` | unchanged | `held` |
  | `expired`, generation live (`retry_at IS NULL`) | becomes `held` again, `holder_count` goes up | `rehold` (a metric) |
  | `expired`, generation retired | unchanged | `lost`: an invariant breach, an operator alert, and the mailbox marks the referencing draft or upload unusable instead of serving a missing object |
  | absent, and its `raw/` or `att/` generation row no longer exists | nothing; never re-created | `lost`, as above: that row is dropped only after a confirmed DELETE |
  | absent, otherwise | nothing; never re-created | `released` (a metric) |
  | `tombstone` | unchanged; never revived | `released` |

  An absent holder whose generation still exists was released by a path that a published state ordered: a pending release, a finished send's cleanup, or the commit-failure path. Re-creating it would bring the leak back.
- **Expiry:** the sweeper's alarm turns provisional holders with `expires_at <= now` into `expired`, in bounded batches. They leave `holder_count` and refresh `last_ref_at`, so the retention grace counts from the expiry. The row is kept, so a later `confirm` can still tell an expiry from a release. `nextSweepAt()` includes the earliest provisional `expires_at`, and the off-mode and disabled rechecks use it too.
- **`release`** deletes the row in any state except `tombstone`, and adjusts `holder_count` only for a counted state.
- **Retired generations:** the sweep transaction that deletes a retired generation first deletes that generation's `expired` and `tombstone` rows.

**Mailbox.** Every holder that M3-2 creates for a draft revision, an upload or a forwarded part is taken with `holdProvisional` before the PUT. Draft revisions are stored as `raw/<sha256>/<gen>` generations registered through `holdProvisional`, so they are swept like any other generation; the legacy prefix-less `drafts/` keys get no new writes. The commit that references it also produces a **pending confirmation** `(seq, key, holder)`. It is derived inside `apply()` from the event's own fields, like M3-2's pending releases, and never inserted separately on the API path. It is captured in `captureSnapshot`, restored in `restoreSnapshotRow` and cleared in `resetForRestore`, so a restore from delta or snapshot coverage brings back exactly the confirmations of published commits. A pending confirmation is not removed when `sendDraft` deletes the draft row that referenced it: the send keeps referencing the revision, so the revision is confirmed, and its release follows the send's finish rule. After a successful publish, the `journal_flush` lane first confirms the entries with `seq <=` the published seq (bounded, idempotent batches of 64, each removed only after the sweeper acknowledges it), then drains pending releases. While covered entries remain, the lane lowers its own row to now + 60 s through the lower-only API; its deadline is otherwise unchanged, and so is the M3-1 driver.

**Unconfirmed holders alert.** The mailbox raises `holder_confirm_stale` (a mailbox alert like `backup_stale`, once per day) when any pending confirmation covered by a successful publish is still unconfirmed one hour later. Publishing working while confirmation fails is therefore visible long before any expiry. Publishing alone does not protect a holder: only a successful `confirm` does. A provisional holder expires 7 days after its hold unless confirmed, and the 42-day bound below ends only with a successful confirmation, which normally follows each publish within a minute.

**A lost source never becomes MIME.** If a send's source (its draft revision or an upload or forwarded part) answers `lost`, release step 2 (section 2.4) ends the send `failed` with `delivery_error`, with one failed ledger row per recipient, internal and external, and raises an operator alert, and neither release nor a restore ever builds MIME from it. A draft or upload whose holder answers `lost` is marked unusable.

**Holder ids** contain the mailbox's holder scope (as `message:<holderScope>:…` does), because the sweeper is per workspace and two mailboxes must never share a holder id. They also contain a value minted before the hold that no restore can rewind: the existing draft and upload UUIDs and revision ids, for example `draft:<holderScope>:<draftId>:<revision>`. A client retry mints a new id; its earlier holder is an orphan, and orphans expire. These ids are up to about 150 characters, so the mailbox's own holder bound (128 in M3-2's event validation and pending-release queue) is raised to 256, the sweeper's existing limit. That stays compatible with replays of older events.

**Why this fixes both paths.** A holder whose referencing commit never existed (a crash) or was rewound (a restore) is never confirmed, because no published state carries its pending confirmation. It expires and is released, and the object follows the normal retention grace. A holder whose commit is published is confirmed, and from then on behaves like any held holder.

**`PROVISIONAL_TTL` is 7 days.** It must be far longer than any normal time from commit to publish: settings and drafts publish within 60 seconds, flags within an hour, and `backup_stale` alerts fire at twice those intervals. A commit that stays unpublished for 7 days means the mailbox's backup has been failing for a week with alerts firing. Even then nothing is lost at once: the expired holder's object is retired only after the 35-day retention grace from the expiry, and a confirmation in that window re-holds it (`rehold`). Losing an object therefore needs 42 days without a successful confirmation (normally, without a successful publish; a confirmation failing behind working publishes raises `holder_confirm_stale` within an hour), and the `lost` answer turns even that into an alert and an unusable draft, never a silently missing attachment: `confirm` answers `lost` for an expired holder on a retired generation, and for an absent holder whose `raw/` or `att/` generation row no longer exists, because that row is dropped only after a confirmed DELETE.

**Restores.** Restored state is published by definition, so `restoreStep` confirms each pending confirmation as it applies it, in bounded idempotent batches, instead of waiting for `ready` and the lane. A failed confirmation batch pauses the restore and is retried with the restore's backoff, like the restore's other sweeper calls; after 5 failures the `restore_blocked` alert fires. Entries answered `lost` are skipped for the rest of the restore and are handled by the lane after `ready`. `restoreStep` removes only entries answered `held`, `rehold` or `released`. A `lost` entry stays pending, because marking a draft unusable is a journalled change and must not be written in the middle of a replay; the lane handles it after `ready`. The lane acts on a `lost` answer (the alert and the unusable mark) only if the current mailbox state still references that exact holder; an entry for a revision, upload or part that a later event replaced or removed is dropped like `released`, so a replayed older event never raises a false alert. This closes the window in which a mailbox stuck in `restoring` or `missing` could let a published reference expire. The remaining case, a restore blocked for more than 42 days, ends in the `lost` alert.

**Not changed.** Inbound holders, index-row holders, `register` for inbound deliveries, and M3-3's `registerSend` keep their current rules. The retention grace, the generation choice, retirement (`retry_at` is never cleared) and the 35-day sweep are unchanged.

### 2.8 Request rate limits

Contract section 5 runs rate limits in the first step of every request, before the idempotency lookup, and answers 429 `rate_limited` with `Retry-After` and `retryAfterSeconds`. **The limiter is required whenever the mail API is enabled; there is no switch to turn it off.** In deployed environments, neither `MAIL_SEND_ENABLED` nor `MAIL_DRAFT_UPLOADS_ENABLED` turns on until R1 has merged and that environment's limiter bindings are configured and verified. Local workerd and CI fixtures may use test bindings. The check has two steps: before enabling, an operator probe calls each binding directly (one test-only key per bucket, which can neither send nor upload) and sees it refuse past its limit; then, once a flag is on and before user traffic is admitted, an HTTP check on each enabled **bucket** shows both sides of its limit without changing data, through any route in that bucket that has a side-effect-free form: a write missing its required header (428 under the limit, then 429), or a read of a not-found id (404, then 429). Routes without such a form, such as `listSends` or `deleteUpload`, share their bucket with a route that has one, and the bucket check covers them. The undo flood guard is checked with distinct not-found send ids, so the per-send buckets never fill first.

- **Where:** in `mail-web`, after authentication, CSRF, `access`, re-authentication and every feature-availability check (501), including the content-URL dependency that the gateway checks today only after mailbox dispatch, which R1 moves ahead of the limiter. The limiter runs before the missing-header check (428), the idempotency lookup and any body read. So a rate-limited request, including a same-key retry of a committed request, answers 429 and never replays a stored result or reserves a key.
- **Mechanism:** the Workers Rate Limiting binding (`ratelimits` in the Wrangler configuration), one namespace per bucket, with a 60 s period. Bucket keys come only from the verified session (the account user id, the mailbox and workspace ids the gateway resolved), never from request input, with one exception: the undo bucket appends the parsed `sendId` from the path to the verified mailbox id. The mailbox part is never caller-supplied, so a caller can only spread its own undo requests across its own buckets. A missing binding fails closed: the route answers 503, never runs unlimited. Its counters are per location and approximate, which is enough for abuse control. It is not a quota: the account quota gate (M3-6) stays the authority for sends. R1 checks the binding's current pricing and records it in its PR before adding it; it expects no new spend.
- **Buckets** (configuration, never code constants; the starting values below are sized from the M2 UI, where autosave writes about once every 5 s per open draft):

| Bucket | Key | Starting limit |
|---|---|---|
| Reads (`GET`) | account user | 600 per 60 s |
| Writes (other methods, except below) | account user | 120 per 60 s |
| Uploads (`createUpload`) | account user | 64 per 60 s (two full 32-attachment drafts) |
| Sends (`sendDraft`) | mailbox | 20 per 60 s |
| Undo (`undoSend`) | mailbox and send id | 10 per 60 s per send, a bucket of its own that sends never consume |
| Undo flood guard | account user | 600 per 60 s across all undo requests |
| Admin writes | workspace | 60 per 60 s |

- **Undo is never starved by sends or by other sends' undos:** each send has its own undo bucket, so a timely undo of a pending send (one request plus its same-key retries) always fits, whatever happens to other sends. The flood guard only stops one user's clients from sending hundreds of undo requests a minute for random ids; only that mailbox owner's own clients can reach it, so the only way to starve an undo is self-inflicted flooding, which is an accepted limit.
- **Answer:** 429 `rate_limited` with `Retry-After` and `retryAfterSeconds` equal to the bucket's period, the usual problem body, and no state change. A 429 is never stored as an idempotency result.
- **Logs:** the bucket name and a count only, never the user, mailbox or address.

## 3. Packages

| # | Package | Builder | Tier | Depends on | Size (est) |
|---|---|---|---|---|---|
| M3-0 | Measurements on the approved test route | Sol | T1 | an approved test route | 0.5 to 1 day |
| R1 | Request rate limits (section 2.8); gates enabling any M3 flag | Sol, Opus review | T0 | M3-2 | 0.5 to 1 day |
| M3-1 | Timers table and one multiplexed alarm | **Opus** | T0 | inbound mailbox PRs merged | 0.5 to 1 day |
| P0 | Provisional holders in the sweeper (section 2.7) | **Opus** | T0 | none | 0.5 to 1 day |
| M3-2 | Drafts, uploads and idempotency in the mailbox | Sol, Opus review | T0 | M3-1, P0 | 1 to 1.5 days |
| M3-3 | Send state machine: `pending_send`, undo, release | **Opus** | T0 | M3-1, M3-2, R1 | 1.5 to 2 days |
| M3-4 | MIME builder and sent copy | Sol, Opus review | T1 | M3-3 | 0.5 to 1 day |
| M3-5 | Send consumer, per-recipient ledger, DLQ | **Opus** | T0 | M3-3, M3-4 | 1.5 to 2 days |
| M3-6 | Account quota gate | Sol, Opus review | T0 | M3-5 | 0.5 day |
| M3-7 | Send-as check and the sender allow-list deploy | **Opus** (check), Sol (CI) | T0 | M3-3 | 0.5 to 1 day |
| M3-8 | Internal delivery (our own recipients) | **Opus** | T0 | M3-5, inbound outbox | 1 to 1.5 days |
| M3-9 | Suppression handling | Sol | T1 | M3-0, M3-5 | 0.5 day |
| M3-10 | From rewriting for group re-sends | Sol, Opus review | T0 | groups designed (not in version 1) | 0.5 day, gated |
| M3-11 | Compose UI on the real send path | Sol | T1 | M3-3, the M2 wiring lane | 0.5 to 1 day |
| M3-12 | End-to-end send matrix | Sol runs, Opus triages | T1 | all above, test route | 1 day |
| M3-13 | Revocable file links for outside recipients (`/f/<token>`) | **Opus** (token and authorisation), Sol (UI) | T0 | M3-2, a contract revision | 1 to 1.5 days |

**Critical path:** M3-1 → M3-2 → R1 → M3-3 → M3-5 → M3-8 → M3-12, about 7 to 10 working days. M3-0 runs in parallel as soon as a test route is approved. M3-4, M3-6, M3-7 and M3-9 overlap the path.

### R1 Request rate limits (Sol, Opus review)

**Change:** section 2.8 in `mail-web`: the buckets as configuration, the content-dependency availability check moved ahead of the limiter, the limiter call in the first step of the request, fail-closed on a missing binding, and the 429 answer.

**Acceptance:**
- With a fake limiter binding in local workerd, each bucket answers 429 `rate_limited` once its limit is reached, with `Retry-After` and `retryAfterSeconds` both equal to the period, and other users', mailboxes' and workspaces' buckets are unaffected.
- **Order:** authentication, CSRF, access, re-authentication and availability failures (501, including the content dependency) never call the limiter; a denied request with missing headers answers 429, not 428; denied `createDraft` and raw `createUpload` requests read no body and look up no key.
- **Undo under saturation** (a gateway fixture standing in for the mailbox): with the send bucket exhausted, and with other sends' undo buckets exhausted, an undo for a different pending send still reaches the handler.
- A 32-attachment compose with the limiter on uploads every file.
- A missing binding answers 503 and admits nothing.
- A same-key retry of a committed `createDraft` that is rate-limited answers 429 and does not replay; after the period it replays the stored result.
- A rate-limited request reads no body, reserves no key and writes nothing.
- A 429 is never stored as an idempotency result.
- The Wrangler configuration stays local-only; the limits are plain configuration values.

**Stop rule:** if the binding's pricing adds recurring spend, stop and report the measured cost before adding it.

### M3-0 Measurements (Sol)

**Acceptance:** a receipt with the raw results for:
- **Size:** the real outbound limit, from sends of 4.9, 5.1, 6, 18, 24 and 25 MiB encoded (just under and over each documented value). It sets `LIMITS.outboundMessageBytes`.
- **Envelope:** whether `send()` accepts envelope recipients separately from the visible To and Cc lists (for partial retries).
- **Message-ID:** whether `send()`'s `messageId` equals the delivered `Message-ID` header.
- **Suppression:** how a dropped (suppressed) recipient is reported in the `send()` result.
- **Errors:** the error codes for quota, header-size and invalid-recipient failures.
- **Quota:** the daily quota's reset time.
- **Headers:** whether `References` at 2,048 bytes is accepted.
- **Clock skew:** the difference between a Durable Object's clock and the consumer Worker's clock, over at least 100 paired samples in different locations. It checks the `clockSkew` assumption of section 2.4.

**Stop rule:** at most 20 sends, only to the approved test addresses. If a result contradicts the contract (for example the limit is under 5 MiB), stop and report it.

### M3-1 Timers (Opus)

**Change:** the `timers(due_at, kind, ref)` table, primary key `(kind, ref)` and indexed on `due_at`. The alarm is always the earliest `due_at`.
- **Kinds:** `journal_flush` (M3-1), `send_drive` (one row per send, section 2.2; M3-3), `upload_expiry` and `idem_expiry` (M3-2), and later `expiry` (Spam and Trash). Daily deltas and weekly snapshots are deadlines computed inside `journal_flush`, not kinds.
- **Successor wake-up first:** before running any handler, `alarm()` sets a durable fallback alarm (as the merged alarm does today), so a crash after one handler's commit still leaves a wake-up for the rest. Every RPC, API write or restore epilogue that writes a timer row also sets the platform alarm to the new minimum before it acknowledges.
- **Order and budgets:** `alarm()` runs at most 64 due rows per call. A due `journal_flush` row always runs first and never waits behind another kind. Handlers of other kinds never hold the mailbox's work lane across a remote call, and their row is already re-armed before they act (section 2.2). The dispatcher races each one against the earlier of 30 seconds and the next `journal_flush` deadline, and any write that moves that deadline earlier while a handler is awaiting I/O (`armFor`, `armSoon`) signals the running dispatcher to re-evaluate the race; if the race is lost it runs `journal_flush` at once, and it does not start that ref again in this isolate until the earlier call settles or one lease period (5 minutes) has passed (an in-memory in-flight set; an evicted isolate takes the call with it). The in-flight set only avoids wasted work: the guarantee that an overtaken run changes nothing is the driver-token compare-and-set (section 2.2), so a run that starts after the 5 minutes while an old PUT is still pending is safe. After the budget of the whole run, remaining due rows wait for an immediate re-arm.
- Timer rows are local scheduling state: they are not journalled and not in snapshots. Each kind registers a handler and, if it has rows, a `rebuild` from journalled state that runs in the transaction finishing a restore (for `send_drive` that is the section 2.5 epilogue). M3-1 registers only `journal_flush`; each later package registers its own kinds.
- The mailbox object's existing backup and restore lane becomes **one** `journal_flush` row, whose `due_at` is exactly the deadline the lane computes today. The lane already schedules daily deltas and weekly snapshots, so those stay inside it rather than becoming separate rows; splitting them would move the recovery boundary. The existing coalescing rules (the earliest deadline wins; an immediate wake-up requested during a run is honoured) are kept.

**Acceptance:**
- Two timers of different kinds both fire.
- Deleting one timer leaves the other.
- A crash after a handler's commit and before re-arm still fires the remaining timers on the next alarm.
- 1,000 due rows drain in 64-row steps without a skipped row.
- A handler of another kind that hangs for 10 minutes does not delay a due `journal_flush`, including a `journal_flush` that becomes due after that handler started, and one that an RPC moves earlier while the handler awaits I/O.
- A timer written by an RPC is armed before the RPC answers.
- The existing journal-flush tests still pass.

**Stop rule:** if multiplexing would change when the journal flushes (the recovery boundary), stop and write a design note.

### P0 Provisional holders in the sweeper (Opus)

**Change:** the sweeper side of section 2.7, in the sweeper ledger and its Durable Object. M3-2 builds the mailbox side on it.
- The `state` and `expires_at` columns and the partial expiry index. Existing ledgers gain both columns by `ALTER TABLE`, so new and existing ledgers share one schema, and every existing holder row becomes `held`.
- `holdProvisional` and `confirm`, each one sweeper transaction, with the answers of section 2.7, including `lost` for an absent holder whose `raw/` or `att/` generation row was deleted. `holdProvisional` refuses a key that is not a `raw/` or `att/` generation key, and arms the alarm at `min(existing alarm, nextSweepAt())` (with the off-mode daily floor) before it commits; `confirm` only adds protection, so it arms nothing.
- Expiry runs at the start of the sweep transaction, at most 64 holders per alarm. While deletes are off (`MAIL_SWEEP_ENABLED` is not `on`) or the backend is disabled, the alarm only re-arms from `nextSweepAt()`, so no holder loses protection while the sweeper is paused.
- `hold` and `register` on an existing `provisional` or `expired` holder make it `held`; on a `tombstone` they add nothing (section 2.4). No API writes tombstones yet; M3-3 adds it.
- Legacy `drafts/` keys keep their current rule: they are never sweep candidates, `holdProvisional` refuses them, and `confirm` answers `released` for an absent holder on one.
- The `SWEEPER` binding type exposes `holdProvisional` and `confirm`, so M3-2 calls them through `Env`.
- Rolling back below this migration is unsupported. The previous build inserts a holder with two positional values, which the migrated four-column table refuses, so its `register` and `hold` fail at once, even while every row is `held`. Once any non-`held` holder row exists, its release would also miscount `expired` rows, and its sweep would hit the foreign key.
- `PROVISIONAL_TTL` is 7 days.

**Acceptance:**
- A provisional holder protects its generation from the sweep; expiry makes it `expired`, and the grace counts from the expiry.
- `confirm` before expiry answers `held`, after expiry `rehold`, and after retirement `lost`, also once the retired generation has been deleted.
- Release then confirm is a no-op (`released`). A confirm that fails, a release that succeeds and a retried confirm leave no holder.
- A tombstone is never revived, and is deleted with its retired generation.
- Confirm racing expiry, in both orders.
- An idle ledger plus one `holdProvisional` produces an alarm at its expiry, with deletes on and off. On a ledger with an overdue generation and no alarm, it arms the earlier deadline. `nextSweepAt()` is the earlier of an unconfirmed DELETE's retry and a provisional expiry, in both orders.
- Repeats are idempotent; `confirm` takes at most 64 entries, and expiry runs in bounded batches.
- A ledger written before this change migrates, and every existing sweeper and reconcile test passes unchanged (three fixtures gain stubs for the two new binding methods).

**Stop rule:** if `holdProvisional` or `confirm` cannot each be one sweeper transaction, stop and write a design note.

### M3-2 Drafts, uploads and idempotency (Sol, Opus review)

**Change:**
- **Drafts:** each revision is an immutable stored object, with a holder registered before its PUT. `If-Match` is checked against the stored revision. Draft revisions are stored as `raw/<sha256>/<gen>` generations registered through `holdProvisional({ kind: 'raw', digest }, holder)` (section 2.7), so the sweep, expiry and retention apply to them; the legacy prefix-less `drafts/` path gets no new writes, and its removal is a follow-up.
- **Uploads:** streamed to `att/<sha256>/<gen>` with the holder registered first. An `upload_expiry` timer runs 24 h after creation and is cancelled while a draft refers to the upload.
- **Forwarded parts:** a draft's `message` attachment reference registers the draft as a holder of that part's object (or of the source raw object for small parts), so Trash expiry of the source cannot remove it before the draft is sent or deleted.
- **Idempotency:** the `idempotency(scope, key, fingerprint, status, body, created_at)` table stores the fingerprint of contract section 5. Only 2xx results are stored, in the same transaction as the effect. The order is contract section 5's: access, re-authentication, rate limits and the presence of required headers run before the lookup; a committed key replays before any existence or `If-Match` check; existence (404) and `If-Match` (412) run only on a key miss. Rows expire after 24 h.
- **Journal:** draft changes are journalled within the 60-second recovery point.
- **Holder releases after publish:** replace, delete and upload expiry never release a holder synchronously. The event that drops a holder records a pending release keyed by its journal seq, in the same transaction. The journal_flush lane, after a publish, releases only entries at or below the published seq, in idempotent, resumable batches of at most 64, and lowers its own row to now + 60 s while covered entries remain. The lane's deadline is otherwise unchanged. An unpublished replacement or deletion cannot release the holder needed by the last published revision. Provisional expiry and the `lost` outcome still follow section 2.7.

**Acceptance:** conformance cases 11, 12 and the draft and upload portions of 15 pass against the backend over HTTP in local workerd, and the draft half of case 21 (header text on `createDraft` and `replaceDraft`). Two tabs saving the same draft: one wins, the other gets `revision_mismatch`. A replayed key whose resource is gone (a deleted draft or upload) still returns the stored result. A replace whose publish fails, followed by a restore, keeps the old revision's raw and att holders held. The post-send sent-copy check in case 15 and stale-`If-Match` key replay for `sendDraft` require the send path.

**Stop rule:** no change to the sweeper's holder rules.

### M3-3 Send state machine (Opus)

**Change:** section 2, the `pending` → `queued` steps: `sends` and the ledger insert, the `send_drive` timer and its handler, the finish rule; `sendDraft`, `undoSend`, `listSends`, `getSend` and release; the sweeper's `registerSend` and `releaseSend`; the restore epilogue in the same transaction as the `ready` transition, and the reset of the new tables.
- **Package boundary:** M3-3 builds the sent copy through a MIME-builder port (a deterministic test builder until M3-4 lands) and enqueues through a queue port. Its acceptance ends at the published release and the enqueue; restore cases around `send()` belong to M3-5, and recipient-delivery cases to M3-8.

**Acceptance:**
- Conformance cases 13, 14, 22 and 23 pass against the backend.
- **Registration against a sweep:** a `registerSend` for a digest whose only generation is unheld and past its grace, interleaved with a sweep at every point: the registration either names a live generation that now has both holders or a newly minted one, never a retired generation; a repeated call returns the same record and adds no holder; a repeat with a different digest is refused; a `registerSend` arriving after `releaseSend` tombstoned its key adds nothing.
- **Frozen inputs:** a rerun of release after a restore rewound it, with the user's `Reply-To` and display name changed and the builder version bumped in between, builds the same bytes and the same key.
- **Release waits for the send to be published:** with the publish failing after `sendDraft`, no `registerSend`, PUT or enqueue happens; a restore then loses the send and leaves no registration behind.
- **Release-time failure:** after an owner change during undo, `getSend` reports each recipient `failed` with `invalid_sender`, also after cleanup.
- **Lost response:** `sendDraft` commits and its response is dropped; the same-key retry, with the same `If-Match`, returns the send (202, its current state), never 404 or 412, and no second send exists. The same holds for `undoSend` after the restored draft was edited.
- **Owner change or alias removal during the undo window:** the send ends `failed` with `invalid_sender`, with no queue message, no `EMAIL` call and no sent copy.
- **Two sends in one undo window; undo one:** only the other is released.
- **Crash injection** after each release step (the state commit, the PUT, the index commit, `queue.send`): there is always exactly one sent copy and at least one queue message.
- **Restore matrix:** restore during each state M3-3 drives (`pending`, `releasing`, `queued`, `cancelled`, and a terminal send with `finish_pending`), right after `sendDraft` answered, and right after `undoSend` answered. After each restore:
  - every accepted send is released (or ends terminal), and no undone send is released;
  - a draft whose message was released does not reappear, and its sent copy is in Sent;
  - a crash during the epilogue still re-drives every send.
- **Barrier:** with the journal publish failing, `sendDraft` and `undoSend` answer 409 `idempotency_in_progress` with `Retry-After`. A same-key retry after the publish recovers returns the original result. While the publish keeps failing, no queue message and no `EMAIL.send()` happen.
- **Undo lost to a restore:** `undoSend` commits, its publish fails (409), and a restore brings the send back `pending` past its old `undoUntil`: the epilogue gives it a fresh window, and the client's same-key retry undoes it; nothing goes out.
- **Concurrent barriers:** two sends releasing at once in one mailbox both publish without a manifest conflict.
- **Second delete:** an object recreated under a retired generation between the sweeper's two deletes is gone after the second, and the ledger row is dropped only then.
- **Late PUT after release:** an overtaken run's PUT completes after the send was cancelled and `releaseSend` ran: the object is under an unheld ledger generation and is swept after the grace; no object exists without a ledger row.
- **Overtaken handler:** a release handler stalls 10 minutes in its PUT while the next firing releases and finishes the send; when the stalled PUT returns, that handler commits nothing and the send stays finished with no drive row.
- **Undo with the limiter on (R1):** with the send bucket and other sends' undo buckets exhausted, the user undoes a pending send within its window: it ends `cancelled`, and no queue message and no `EMAIL` call happen.
- **Undo racing the alarm:** either `cancelled` with no queue message ever, or released with undo answering `send_not_pending`. Never both.

**Stop rule:** if the Durable Object's single-threaded ordering cannot give the undo-or-release guarantee without a lock, stop and redesign. Do not add a timer guess.

### M3-4 MIME builder and sent copy (Sol, Opus review)

**Change:** build the structured `send()` request and the RFC 5322 MIME of the sent copy:
- UTF-8 headers as RFC 2047 encoded words;
- the text part in quoted-printable or base64, whichever is smaller, so it is never larger than base64 (the client's `attachmentBudget` relies on this);
- `multipart/mixed` with a `text/plain` part and base64 attachments;
- `In-Reply-To` and `References` from `threadingHeaders` (contract section 8.3): the first id and the last 10, trimmed further by bytes so the unfolded value fits `headerValueBytes`;
- the request's own headers: only `In-Reply-To`, `References` and `Reply-To`, each within `headerValueBytes`. Everything else comes from the structured fields;
- the encoded size, which is the server's `message_too_large` check.

**Acceptance:**
- Golden-file tests, and conformance case 21 in full against the backend (it reads the stored sent copy).
- Parsing the output back with PostalMime gives the same addresses, subject, text and attachment bytes.
- CR, LF or another control character in any name, subject or address is refused with `invalid_header` before building, never stripped silently. The builder also refuses one as a programming error, in case a draft bypassed the save check.
- A reply in a thread of 12 legal 200-byte `Message-ID`s: `References` fits 2,048 bytes and keeps the first and newest ids (golden file). An id longer than 2,048 bytes is never sent.
- Every physical header line of the stored MIME is at most 998 octets: `References` folds between ids.
- A forwarded part whose indexed name is not a plain token is written with an RFC 2231 `filename*` parameter (and a `_`-substituted ASCII `filename`), never raw; golden files cover a name with quotes, a semicolon and non-ASCII text. The conformance suite reads only top-level headers, so this check lives here.
- The built request sets no header outside the three above, and never `Bcc`, `Sender`, `From`, `Return-Path` or `Reply-To` from user input; a test lists its header names and counts them (at most 3).
- 50 recipients, 32 attachments and the measured limit are each accepted, and one more of each is refused.

### M3-5 Consumer, ledger and DLQ (Opus)

**Change:** section 2, consumer and dead-letter queue: the `send` queue and its DLQ, `claimSend`, `recordResult`, `delaySend` and `abandonClaim` with fencing, `next_attempt_at`, the caps and the deadline, and the ledger states `pending`, `attempting`, `sent`, `failed` and `suppressed`; the attempt history; the `send_results` table (a D1 migration) and result notices; late confirmations.

**Acceptance:**
- With the fake `EMAIL` binding:
  - A retry sends to `pending` recipients and to `attempting` recipients whose lease expired, never to terminal ones.
  - A crash between Mark and Send, and a crash after Send: each recipient gets the message, with at most one extra copy, and the send ends terminal.
  - A consumer that crashes and whose queue message is redelivered within the lease: the redelivery is acknowledged, and the drive row (moved to the lease expiry) re-drives the send.
  - Ambiguous provider errors: 3 of them end the remaining external recipients `failed` with `delivery_error`; rate-limit errors never do. On a mixed send, a pending internal handoff still completes and the send finishes only after it.
  - The 72-hour deadline ends a stuck send, and time in `delayed` does not count toward it.
  - Every delivery of the claim RPC fails until the message dead-letters: the drive handler re-arms and re-drives, and the send still reaches a terminal state.
  - A `claimSend` committing while the drive handler awaits its enqueue: the send still has exactly one drive row, at the lease expiry.
  - After a quota wait, the send has exactly one drive row, and the claim refuses before `delayedUntil`.
  - Stale-fence `abandonClaim` and `delaySend` change no recipient, lease or timer.
  - A stray queue message right after an ambiguous error is refused until `next_attempt_at`.
  - A publish failure during the finish rule, then recovery: the send ends with no drive row and its holders released.
  - An outage of the quota object for 3 days fails no send; the 24-hour alert fires.
  - The quota object or Mark failing for 30 minutes: `abandonClaim` keeps every recipient `pending`, no cap is reached, and the sends go out after recovery.
  - A rate-limit backoff shorter than the lease: the lease ends with the report, and the backoff timer re-drives.
  - Every terminal path releases the send's holders and deletes its timers.
  - The deadline or `invalid_sender` ends a send while an earlier consumer is past its lease: that consumer's `delaySend`, `abandonClaim`, Mark and any failure, retry or ambiguous `recordResult` change nothing, and the send stays terminal; only a confirmed result from a fence whose Mark set held the recipient applies, as a late confirmation.
  - **No starvation:** 100 stored results for a mailbox that stays restoring for a day do not delay recording another mailbox's stored result past one reconciler interval, and the restoring mailbox's rows cause no more than one notice per row per backoff step.
  - **Late result after cleanup:** fence B's rejection finishes the send and cleanup ends; fence A's stored acceptance, with every notice dropped, is recorded through the reconciler path, the recipient ends `sent`, no drive row reappears, and a later restore keeps the outcome.
  - After a restore, stored results that make every recipient terminal finish the send, with no empty claim and no false alert.
  - **Restore matrix around `send()`:** a restore during `delayed`, during `sending`, and between `send()` returning and its result being published: every accepted send reaches a terminal state, and every recipient receives the message at least once, with one extra copy only for the ambiguous case (section 2.6).
  - Mark failing for 30 minutes leaks no quota reservation; other mailboxes are not delayed.
  - A restore after `send()` and before its result is published: the restored recipients are `attempting`, and the next claim treats them as ambiguous (metric and alert). Three such restores in a row never fail the send, and five consumer crashes after authorization hold it rather than fail it.
  - A stale fence cannot record `failed`, a retry or an ambiguous outcome.
  - A crash after `send()` and before recording resends at most once more and never loses a recipient. The test counts calls per recipient.
  - A partial failure gives `partial` with per-recipient reasons.
  - The quota error gives `delayed` with a timer.
  - A DLQ message never changes the send, and is acknowledged only after the fake alert binding answers 2xx.
  - An alias removed (or the mailbox given to another owner) while a send is `delayed`: the next attempt ends `failed` with `invalid_sender`, with no `EMAIL` call.
  - While the mailbox is `restoring`, the consumer acknowledges without sending and without spending a queue retry; the send goes out after the restore through its timer.
  - A stale fence (after a restore) cannot send, records a confirmed `sent`, and cannot record `failed`, a retry or an ambiguous outcome; no fence changes a terminal recipient except by a late confirmation.
  - **Late confirmation:** a stored `sent` result delayed past the post-restore hold (a 6-hour restore), with an owner change in between: the recipient first ends `failed` with `invalid_sender`, then the late result replaces it with `sent`, the send's state is recomputed and published, `send_late_confirmation` rises, and no `EMAIL` call, drive row, lease or reservation change follows. The same for `delivery_error` after a cap or the deadline, and for an accepted result from fence A arriving after fence B recorded a provider rejection (the recipient ends `sent`). A fence whose Mark set did not include the recipient changes nothing for it.
  - A result notice during a long restore re-enqueues itself without dead-lettering; dropping every notice still records the stored result through the drive row after the restore.
  - The send's object holders are released only after the terminal state is published.

- **Dispatch fencing,** with a controllable clock in the Durable Object and the consumer, and the fake `EMAIL` counting calls per recipient and fence:
  - The quota confirmation stalls past the lease expiry: `authorizeDispatch` answers `stale`, no `EMAIL` call happens under the old fence, the next claim sends once, and the account's quota balance shows one charge per recipient, not two.
  - A restore starts while the quota confirmation stalls: `authorizeDispatch` answers `stale` and no `EMAIL` call happens under the old fence. The restored recipients are claimed only after the old published `lease_until`.
  - A restore between `authorizeDispatch` and `send()`: the old call starts before its deadline; the post-restore claim sends only after the old `lease_until` and counts the recipients as ambiguous; each recipient gets at most 2 calls.
  - The mailbox changes owner, or the alias is removed, while the quota confirmation stalls: the send ends `failed` with `invalid_sender`, with no `EMAIL` call.
  - The consumer stalls after `authorizeDispatch` past its deadline: no `EMAIL` call, `abandonClaim`, and the send goes out on the next attempt.
  - Independent clocks: the reclaiming object's clock runs 55 s ahead of the authorizing one, and the authorization is requested at the last moment it is allowed: no two calls for one recipient have overlapping dispatch windows. At 65 s ahead the test shows the overlap, documenting the `2 × clockSkew` bound. The consumer's clock stepping back 20 s during `authorizeDispatch`, with the reclaiming clock 35 s ahead, still keeps the windows apart (55 s of the 60 s budget).
  - `recordResult` throws once after an accepted `send()`: the stored result is recorded, and each recipient gets exactly one call.
  - The mailbox changes owner while an authorized call is slow past its lease: the next claim holds the recipients one lease period, and the late confirmed `sent` is recorded instead of `invalid_sender`.
  - The same with a restore longer than a lease in between: the hold starts at the end of the restore, and the stored `sent` is recorded.
  - Two mailboxes whose sends share a `sendId` and an external recipient: their reservations and fences stay independent.
  - The quota confirmation stalls, the next claim commits and its consumer crashes before reserving: the consumer after it releases the old fence in its own reservation call, and the day's balance shows one charge.
  - **Kept charges never stall a retry:** an authorized fence whose `send()` timed out keeps its charge, and the retry under the next fence reserves and sends without waiting for it; the day's balance shows two charges for that recipient. A never-authorized fence on the release list is released by the next consumer's quota call, and a crash before Mark leaves it on the list for the consumer after that.
  - **Release list at finish:** fence A authorized with an ambiguous result, fence B confirmed and crashed before authorization, claim C listed B and its consumer died, then an alias removal ends the send: finish releases B's charge, keeps A's, and leaves an empty list.
  - **Empty claim:** a duplicate dispatch for a mixed send whose external recipients are terminal and whose handoff is pending (a handoff stub here; the real pipeline is M3-8's) takes no lease, no attempt and no reservation, and leaves `send_drive` where the handoff put it.
  - **Dispatch at the reset:** a charge confirmed just before the daily reset with the directory check finishing after it: `authorizeDispatch` refuses, the consumer gets `quota_window`, abandons until just after the reset with its reservation released, the next claim is charged to the new day, the call is counted in the day it is made, and no fence gets more than two `authorizeDispatch` calls.
  - **Across quota days:** a stale consumer whose fence was released on day D cannot re-reserve under it on day D+1.
  - Across all of these, no `EMAIL` call starts after its authorization deadline or under a fence whose `lease_until` has passed.

**Stop rule:** if a confirmed `send()` result cannot be recorded reliably (directly or through `send_results`), stop and report. Do not add sleeps or retries around `send()`.

### M3-6 Quota gate (Sol, Opus review)

**Change:** one quota Durable Object per account counts reserved recipients per quota day and per calendar month.
- **The daily gate** stops at 80% of the daily quota (today 1,000, so 800). That leaves room for the account's other transactional mail, such as password resets, which shares the quota.
- **The monthly gate** stops at the approved spending ceiling: the included 3,000 plus the approved extra spend. It is configuration, never a code constant.
- **When a gate is hit**, the send becomes `delayed` until the reset, and the operator alert fires once per day.
- **Release on failure:** a failed attempt releases its reservation.

**Acceptance:**
- 20 concurrent reservations never exceed the gate.
- Reservations survive an object restart.
- A reservation made before the daily reset and confirmed after it is counted in the new day; releasing its fence finds the charge in whatever day it sits.
- The day and month resets follow M3-0's measured reset time.

### M3-7 Send-as and the allow-list (Opus check, Sol CI)

**Change:**
- **The check:** `from` must be an identity of the mailbox with `sendAs: 'active'`. It is checked on `sendDraft` and again at release, at each claim and at `authorizeDispatch`, always as the one directory statement of section 1.
- **The allow-list:** the `send_email` binding's `allowed_sender_addresses` is generated in CI from the directory. A second plain variable from the same source lets `mail-web` mark an identity `active` only once the deployed list contains it.
- **Headers:** a user-supplied `Sender`, `From`, `Return-Path` or `Reply-To` header is never accepted. `Reply-To` comes only from settings or group rules.

**Acceptance:**
- An alias removed during the undo window fails at release with `invalid_sender`.
- An address outside the deployed list is `pending` and refused.
- The CI job's dry run prints counts only.

**Stop rule:** the production deploy job is a workflow change (T0). It runs only after review, and the first production run needs explicit operator approval.

### M3-8 Internal delivery (Opus)

**Change:** a recipient in the same workspace (a directory point lookup at release) gets the sent copy through release step 6: the hold, the conditional `internal_handoffs` row and the `sent` ledger commit; then the pipeline's expansion into single-mailbox child `deliveries` rows (`source = 'internal'`, deterministic ids, each holder taken before its row), including `file_sent` rows for the sender's own mailbox and non-delivery notices. Child rows reuse the inbound fence, completion cursor, replay and pruning unchanged. It makes no `send()` call and uses no quota.
- **Migration:** the `internal_handoffs` table; `source` (`inbound`, `internal`) and `kind` (`deliver`, `file_sent`) columns on `deliveries`; tombstoned holders in the sweeper ledger.
- **Trust:** the mailbox trusts an internal message's sender only from the `source` column, which only the pipeline's expansion writes. It never trusts a header in the MIME.

**Acceptance:**
- An internal recipient receives the message with no `EMAIL` call.
- An internal To recipient and an internal Bcc recipient each receive a copy with no Bcc addresses in it (the delivered MIME is the stored sent copy, which never has a `Bcc` header).
- An inbound message carrying any "internal" header is still scored as inbound.
- Mixed internal and external recipients each reach a terminal state.
- **Crash after release step 4a and before the handoff insert, and after the hold but before the insert,** for an internal-only send and for a mixed send whose external recipients are already terminal: the send does not finish, the drive row re-drives the handoff, each recipient mailbox gets exactly one delivery, and the send's own holders are released only after every internal row is `sent`. The raw object exists throughout, and the sent copy's index holder stays as long as its Sent entry.
- **Release publish failing, then a restore, then undo:** no internal delivery happens, because the handoff waits for the published release.
- **A domain moved to another workspace, or an alias deleted, while the handoff is pending:** that address receives nothing, and the sender's mailbox gets a non-delivery notice for it.
- **Re-handoff after the pipeline already expanded the handoff** (the ledger commit was lost to a restore): nothing new is written, no second delivery or live holder appears, and every holder of the handoff and its children ends released.
- **Concurrent expansion:** two expanders race while an alias is reassigned from A to B: only the stored plan's mailbox receives a child, and a crash after the holds and before the write repeats with the same ids and leaves no stranded holder. An alias revoked after an expander read the directory but before its plan commits is not in the plan. A crash after the expansion batch and before the holder release is finished by the reconciler, and the handoff is not pruned before.
- **Rejected handoff cleanup:** a `rejected` decision ends the internal rows `invalid_sender`; after the publish, finish releases the handoff holder (tombstoned) and then acknowledges the row; with the sender's copy deleted, the generation becomes sweepable.
- **Release retries do not block:** a page of flagged handoffs whose sweeper calls keep timing out does not stop another workspace's flagged handoff from being released within one reconciler interval.
- **Empty dispatch during a pending handoff:** with the real pipeline, a duplicate dispatch for a mixed send whose external recipients are terminal changes nothing, and the handoff still completes.
- **Stale handoff write:** a driver's handoff insert is delayed in flight while a newer driver records `rejected` and publishes `invalid_sender`; the sender identity is then re-enabled and the old insert lands: it is ignored, and nothing is delivered.
- **Two unroutable addresses:** the sender gets two distinct notices, each exactly once across retries, and neither collides with a `file_sent` child.
- **Recipient restore:** a recipient mailbox restores after indexing its child delivery but before its backup covers it: replay brings the message back. The same for one recipient restoring during a two-mailbox fan-out; the other keeps exactly one copy.
- **Sender restore after self-filing:** replay of the `file_sent` row files the sent copy again through the conditional filing, never through `ingest`, still only if its `folder_rev` matches; with the sent copy gone it is a no-op.
- **Owner change or alias removal while the outbox is down,** including one that commits while the handoff batch is in flight but before it: the internal rows end `failed` with `invalid_sender` and nothing is delivered; once the row was written, the change no longer recalls it.
- **The sender deletes the sent copy, and the sweeper runs, while the outbox is down:** the raw object survives through the send's raw holder, and the handoff delivers it after recovery.
- **Tombstone timing:** a handoff repeated after processing but before the acknowledged mark writes nothing; the tombstone is not deleted before the mark plus 7 days.
- **Sending to oneself and to an alias of oneself:** the sender's mailbox has one copy, the sent copy, and no delivery. If the alias moves to another mailbox between the release lookup and the handoff, that mailbox receives the message.
- **Restore after an unpublished release, then undo:** neither sent-copy holder survives; the test runs against the real sweeper API and finds them through the registration, including after a lost registration reply.
- **An alias moved to the sender after release:** the sent copy, filed in Archive at release, is moved into Inbox at delivery, and the sender's mailbox still has exactly one copy.
- **Folder changed after release:** the same, but the sender moves the sent copy to Trash and back to Archive before delivery, both moves published: it stays in Archive. A move made while the handoff waits for an outbox outage is also kept (the handoff carries the release-time `folder_rev`). A delivery repeated after the filing leaves it where it is.
- **Two mailboxes with the same `sendId`:** each gets its own handoff row; neither is marked `sent` from the other's row.
- **Outbox down, then the alias reassigned or deleted:** an alias moved from mailbox A to mailbox B while the handoff waits is delivered to B, never A; a deleted alias is delivered nowhere.
- **Outbox down while the external recipients are `delayed` by quota:** the internal delivery completes after the outbox recovers, long before the quota reset, and the external recipients stay `delayed`.
- **Crash after the outbox insert and before the ledger commit, and a restore in the same gap:** the handoff repeats, the insert is a no-op, and the recipient sees one message.
- **The outbox write failing for 30 minutes:** the rows stay `pending`, nothing fails, and the handoff completes after recovery.

### M3-9 Suppression (Sol)

**Change:** map the provider's dropped-recipient result (M3-0) to `suppressed`, show it in `getSend`, and count it in the daily operator digest.

**Acceptance:** the fake binding's dropped recipients show as `suppressed`, and the send is `partial`.

**Stop rule:** never remove or add suppressions. The admin suppression list waits for a token scope.

### M3-10 Group From rewriting (gated)

**Change:**
- An outside member's copy of a group post gets `From: "<Name> via <Group>" <group@domain>` and `Reply-To` set to the original sender.
- The group's own object keeps the ledger.
- Only posts whose first `Authentication-Results` from the platform shows `dmarc=pass` for the `From` domain are re-sent; others are held for moderation.

**Gate:** groups are not in version 1 of the contract. Start only after groups are designed.

### M3-11 Compose UI (Sol)

**Change:**
- the undo toast driven by `undoRemainingMs`;
- `Sending`, `Delayed`, `Partly sent` and `Failed` chips from `listSends` and `Message.send`;
- the suppressed-recipient notice;
- the attachment budget from `attachmentBudget`.

**Acceptance:** Playwright plus axe on the four browser projects, and the M2 send journeys pass against the fake.

### M3-12 End-to-end matrix (Sol runs, Opus triages)

**Scope:** on the approved test route:
- one message each to Gmail, Outlook, iCloud and Yahoo test accounts (the addresses live in operator configuration);
- a reply that threads at the recipient;
- the size limit, 50 recipients, 32 attachments;
- one suppressed address;
- undo;
- internal delivery.

**Acceptance:** a receipt with each outcome. Any lost message stops the matrix.

### M3-13 Revocable file links (Opus, Sol)

**Why:** uploads may be 25 MiB while outbound mail may be capped at 5 MiB, and Drive links reach workspace members only. Until this package lands, the contract refuses an over-budget draft with `message_too_large` (contract section 8.3).

**Change:** first a contract revision: a `file_link` attachment kind, a link expiry chosen by the sender, and routes to list and revoke links. Then the `links` table in the mailbox, a random token per link, and `mail.<suite-domain>/f/<token>` answering with a 5-minute signed download on the content origin.
- That download URL has its own purpose, `lnk`, with the link id as a claim. On every request the verifier checks that the link is still live (a Durable Object lookup, like step 5 of content-origin section 2.3), so revoking a link kills download URLs already minted from it, not only new ones.

**Acceptance:** a revoked or expired link answers 404 at once, including a download URL minted from it just before the revocation; a token never reveals the mailbox or other files; the download headers follow content-origin section 3.4.

## 4. Done

M3 is done when all of the following hold:
- R1, M3-0 to M3-9, M3-11, M3-12 and M3-13 are merged with their acceptance receipts;
- the conformance suite passes against the backend;
- the end-to-end matrix shows zero lost messages.

M3-10 waits for groups.

## 5. Security review checklist (Opus, high effort)

The security review of R1, M3-2, M3-3, M3-5, M3-6, M3-7, M3-8 and M3-13 checks at least:

1. **Send-as:**
   - `from` cannot be spoofed through a display name, an encoded word or a header.
   - A removed alias or a mailbox given to another member cannot send after the undo window, including a `delayed` send's later attempts; `authorizeDispatch` re-checks both. Every sender check is one directory statement (section 1), never two reads.
   - The allow-list and the app check agree.
2. **Header injection:** a control character is refused with `invalid_header` in every name, address and subject (and with `invalid_request` in file and link names). The recipient count cannot grow through a header. Threading headers stay within `headerValueBytes`.
3. **Cross-mailbox references:**
   - `inReplyTo`, `forwardOf`, `message` attachment parts and uploads resolve only inside the session's mailbox.
   - Idempotency keys are scoped per mailbox.
4. **Durability:**
   - No path loses a send between `pending` and a terminal state.
   - Every holder is registered before its PUT and released only when its owner no longer needs the object: an index row is gone, a send is finished (its draft, upload, forwarded-part and raw holders), or a delivery has been indexed.
   - Fencing stops a stale consumer from recording a failure or a retry. A late confirmation comes only from a fence whose published Mark set held the recipient, only upgrades the outcome (`sent` over `suppressed` over failure), and never sends; a stored provider result (`send_results`) is kept until it is recorded and published.
   - `registerSend` chooses the generation, adds both holders and persists the registration in one sweeper transaction, keyed with the digest; release starts only after `sendDraft` is published, every MIME input is frozen in the `sends` row, and `releaseSend` tombstones even an absent registration.
   - A due `journal_flush` never waits behind another timer kind, and every timer write is armed before it is acknowledged.
   - **Dispatch fencing:** every remote wait after Mark finishes before `authorizeDispatch`; no `send()` starts after its authorization deadline; no deadline is later than the published `lease_until`; a claim never sends to a recipient `attempting` under an unexpired lease of any epoch.
   - **Internal handoffs:** every holder is taken before the row it protects, in the sweeper, and handoff and child-delivery holders are tombstoned on release; child deliveries are single-mailbox rows that replay after a recipient's restore; a send finishes only after its handoff row exists; the send's own holders, its raw holder included, are released only then, and the sent copy's index holder only with its index row. The handoff's owner and send-as check is a condition of its insert, in the same commit. The destination mailbox is resolved at delivery from the current directory, never from a mapping journalled at release.
5. **Quota and cost:** one mailbox cannot exhaust the account's daily quota beyond the gate, and the monthly ceiling cannot be passed by concurrency. A retry never releases a kept charge (an authorized or older-epoch fence), and every never-authorized charge on a release list is released before the next fence can send, or by the finish rule when the send ends. The newest fence is tracked across quota days.
6. **Request rate limits (R1):** bucket keys come only from verified session identities and the request's own path ids, and isolate users, mailboxes, workspaces and, for undo, sends; the limiter runs before any key lookup or body read and after every availability check; a missing binding fails closed; undo is never starved by sends.
7. **Trust and privacy of copies:** internal delivery is trusted only from the `deliveries.source` column, never from MIME. No stored or delivered MIME contains Bcc recipients.
8. **Secrets and privacy:**
   - No message content, subject, address or token in logs, alerts or errors.
   - `EMAIL` and storage credentials are never echoed.
9. **Input bounds:** every limit in `LIMITS` is enforced server-side before any storage write.
