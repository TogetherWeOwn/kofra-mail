# M3 outbound: build plan

Status: plan, version 1. It implements the send half of the [Mail API contract](../contracts/mail-api/README.md) (`sendDraft`, `undoSend`, `getSend`, `listSends`, drafts and uploads) on Cloudflare Email Sending.

**Model routing:**
- **Opus** builds the send-path durability, concurrency and authorisation code.
- **Sol** builds the routine parts, and Opus reviews them.
- **Every T0 package gets two independent reviews:** a general review (Sol) and a security review (Opus, high effort). Section 5 is the security checklist.

## 1. Global rules

- **Off by default.** The send path runs only with `MAIL_SEND_ENABLED=on`. Tests use a fake `EMAIL` binding that records calls.
- **No live sends** except in M3-0 and M3-12, and only to the approved test route's addresses. No production deploy, no new spend, and no DNS or suppression-list writes.
- **The mailbox Durable Object owns all send state.** Queues carry ids only (`{ ws, mb, sendId }`); a queue message is limited to 128 KB.
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
- **If a publish fails after `sendDraft` or `undoSend` committed,** the request answers 409 `idempotency_in_progress` with `Retry-After`, never a 5xx: the action has taken effect, and the client must retry with the same key (contract section 5). The release alarm cannot send before the publish succeeds, because release step 4a waits for a publish that covers the `sendDraft` event too.
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
| `queued`, `sending` or `delayed`, an internal recipient not yet handed off | runs the internal handoff (release step 6), then the row for the external state below |
| `queued`, `sending`, every recipient terminal (internal ones included) | runs the finish rule |
| `queued`, `sending`, an external recipient not terminal | enqueues if no live lease holds the send and `now ≥ next_attempt_at` |
| `delayed`, `now ≥ delayedUntil` | sets `queued` and enqueues |
| terminal or `cancelled` with `finish_pending` | resumes the finish rule (section 2.4) |
| anything else | nothing; the row waits for its `due_at` |

  It also checks the deadline (section 2.4).
- **So a lost, duplicated or dead-lettered queue message, a crash in any step, or a failed publish is always re-driven,** and two drivers can never run for one send.
- The alarm never enqueues a `cancelled` send, and the consumer re-checks the state before calling `send()`.

### 2.3 Writes from the API

**Order of checks** (contract section 5): authentication, access, re-authentication, rate limits and header presence (`Idempotency-Key`, `If-Match`) run first. A committed idempotency key then replays **before** the draft's existence or revision is checked, so a retry of a `sendDraft` whose response was lost returns the send although the draft is gone. Only on a key miss do the existence (404) and `If-Match` (412) checks run.

**`sendDraft`** runs in one Durable Object transaction, then waits for the barrier:
1. Validate the draft (contract section 8.3).
2. Insert the `sends` row as `pending`. It points at the immutable stored draft revision and its attachment holders, and records the submitting account user, which release and every claim compare with the mailbox's owner.
3. Delete the draft row. Steps 2 and 3 are one journal event, so a restore replays both or neither.
4. Create the `send_drive` row at `undoUntil`.
5. Store the idempotency result.

**`undoSend`** runs in one transaction, only from `pending`, then waits for the barrier:
1. Set the state to `cancelled` with `finish_pending`, and move `send_drive` to now.
2. Restore the draft under its old id with a new revision (one journal event with step 1).
3. Store the idempotency result, so a retry after a lost response returns the restored draft.

### 2.4 Release, the consumer and finishing

**Release** (run by the drive handler), in order:
1. **Commit:** `pending` → `releasing`. The commit fixes the message's `Date` and derives the MIME boundary and our `Message-ID` from `sendId`, so a rerun builds identical bytes and the content-addressed key does not change. If M3-0 shows the provider replaces `Message-ID`, the index records the delivered id for threading; the stored bytes keep ours.
2. **Re-check the owner, send-as and limits, and resolve internal recipients.** An alias may have been removed, or the mailbox given to another member, during the undo window. A send whose mailbox no longer has the submitting owner, or whose `from` is no longer an active identity, becomes `failed` with reason `invalid_sender`; one over a limit becomes `failed` with `message_too_large` (finish rule). A directory point lookup marks each recipient whose address routes to a mailbox of this workspace as **internal**. Release records only that classification, never the destination mailbox: the handoff resolves the destination at delivery time (step 6).
3. **Store the sent copy:** build the MIME of the sent copy, register the sent copy's **index holder** with the sweeper, and PUT it to object storage (holder before PUT, as on the inbound path). That holder belongs to the sent copy's index row, like any message's, and is released only when that row is gone (expiry or deletion), never by the finish rule. The stored MIME never contains a `Bcc` header; Bcc recipients live only in the `sends` row and the sender's index.
4. **Commit:** index the sent copy (`sent: true`) and insert the ledger rows, `pending`, one per recipient, each `external` or `internal`. Set `releasing` → `queued`.
4a. **Barrier:** publish up to this commit. If the publish fails, stop; the drive timer resumes here.
5. **Enqueue**, only if an external recipient is not terminal: `await SEND.send({ ws, mb, sendId })`.
6. **Internal handoff,** while any internal row is `pending` (M3-8). It runs in the drive handler, never in the consumer, in any non-terminal state including `delayed`, and needs no quota and no `send()`:
   1. **Re-check the sender:** the same directory lookups as `authorizeDispatch` (the submitting owner still owns the mailbox, and `from` is still active). If either fails and no delivery row exists for this send yet, the internal rows end `failed` with `invalid_sender` (finish rule). If the row already exists, the message was handed off before the change, and step 3 follows.
   2. **One atomic batch** in the outbox database, keyed by the delivery id `internal:<sendId>`: `INSERT OR IGNORE` the delivery's own holder on the sent copy's raw object and `INSERT OR IGNORE` the delivery row (`source = 'internal'`, the raw key, that holder, and the internal recipient **addresses**, not mailboxes). Wait until it is acknowledged. A repeat writes neither row, so it can neither deliver twice nor leave a second holder.
   3. Commit the internal ledger rows as `sent`, meaning handed to our inbound pipeline, as `sent` means accepted for an external one (journalled; the finish rule publishes them before they are reported).

   **Tombstones:** the pipeline keeps a processed delivery row as a tombstone for at least 7 days, so a repeat after processing is still ignored. A handoff whose finish is not published within 24 hours raises the stall alert, well inside that time.

   **The destination is resolved when the pipeline delivers,** from the directory as it is then, by the same rules as inbound mail: one copy per mailbox even when several addresses reach it, and an address that no longer routes (an alias deleted meanwhile) receives nothing, because `deleteAlias` stops delivery at once. A row journalled during an outage therefore never delivers to a mailbox that has lost the address; an address moved to another mailbox reaches its new mailbox, as an inbound message would. The pipeline releases the delivery's holder after the last recipient mailbox has indexed the message.

   **The sender's own mailbox is never a handoff target:** the sent copy already sits in its Inbox (contract section 8.3), so release step 4 commits those rows as `sent` at once, and the pipeline skips the sender's mailbox if an alias resolves to it at delivery.

   A crash or a failed write between these steps leaves the rows `pending` and the drive row re-drives them, with the drive backoff. Our own outage never fails an internal recipient; a handoff still pending 24 hours after release raises the stall alert.

Every step is idempotent: the content-addressed PUT, the holder registrations, `INSERT OR IGNORE` of ledger rows and of outbox deliveries. A crash leaves the drive row, which resumes from the committed state, so a crash can cause a second queue message, never zero, and never a second internal delivery.

**Consumer** (`mail-send` Worker), in order:
1. **Claim:** RPC `claimSend(sendId)`, one Durable Object transaction:
   - It refuses a `cancelled` or terminal send (the consumer acknowledges). A send whose recipients are all terminal is finished by the finish rule, never claimed with an empty recipient set.
   - **Not now:**
     - the mailbox is `restoring` or not ready;
     - another live lease holds the send;
     - the release commit is not yet published;
     - the send is `delayed` with `now < delayedUntil`;
     - `now < next_attempt_at`;
     - a recipient is `attempting` under a lease that has not expired, whatever its fence. That includes a lease from before a restore: its consumer may still hold a dispatch authorization until that expiry (step 4). A lease counts as expired only at `lease_until + clockSkew` (below).
     The consumer acknowledges without throwing, so queue retries are never spent on waiting; the drive row re-drives. For a live lease, the claim moves `send_drive` to that lease's expiry.
   - **Only external recipients are claimed.** Internal recipients are handed off by the drive handler (release step 6) and never reach `send()`.
   - **On every claim** it repeats the send-as check (`from` is still an active identity of the mailbox) and checks that the mailbox still has the submitting owner. A `delayed` send can wait hours, so release-time checks are not enough. A failed check ends the send `failed` with `invalid_sender` (finish rule). Step 4 repeats both checks just before dispatch.
   - **Otherwise:**
     - It increments the send's `attempt` counter and takes a lease of 5 minutes with **fence = (recovery epoch, attempt)**.
     - It moves `send_drive` to the lease expiry.
     - It returns the send request plus the external recipients to send to: those still `pending`, and those `attempting` under a lease that has expired. An `attempting` recipient is an **ambiguous event** (section 2.6) only if its fence is from an older recovery epoch (the authorization record is not published, so a restore cannot tell) or an authorization was recorded under its fence. Otherwise `send()` cannot have run: it is returned as `pending`, uncounted, and its lease counts only toward the crash-loop cap.
   - **Crash-loop cap:** a claim whose lease expires with no report at all (no `recordResult`, `delaySend` or `abandonClaim`) while it left recipients `attempting` counts as an unfinished attempt, whether or not it was authorized. A lease that expires before Mark proves `send()` never ran, and does not count. The next claim releases that lease's quota reservations, because they belong to recipients that were never `attempting` under it.
   - **When a cap or the deadline is reached** while some recipients are still protected by the one-lease grace period (below), the claim withholds sending ("not now") and moves `send_drive` to the end of the grace period. The handler then applies the cap or the deadline. After 5 unfinished attempts in a row, the send's non-terminal external recipients end `failed` with `delivery_error` (finish rule), and an alert fires.
2. **Reserve quota:** reserve the recipients in the account's quota object (M3-6). A reservation is all or nothing for the claim, and is keyed by (`sendId`, recipient, quota day, fence). It is provisional: it expires by itself 2 minutes after the claim's lease expiry unless the consumer confirms it (step 3a). A late or stale reservation therefore frees itself. If the confirmation finds the reservation already expired, it reserves again under the same key. If the quota is now exhausted, the consumer calls `delaySend` (Mark's recipients return to `pending`), and never sends unreserved.
     - Every attempt that may call `send()` holds its own reservation, so a retry after an ambiguous result is charged again, as it should be.
     - Only the current fence can release a reservation, through `abandonClaim`, `delaySend` or a rate-limit result under that fence. A stale consumer therefore never frees a newer attempt's charge.
     - An ambiguous or accepted result keeps its reservation. If the quota is exhausted, RPC `delaySend(sendId, until, fence)` sets `delayed` and `delayedUntil`, moves `send_drive` to `until`, returns the recipients to `pending` and ends the lease. Then acknowledge.
3. **Mark:** one transaction that first checks, before writing anything, that the fence is current, the lease is live, the send is not terminal or `cancelled`, and every claimed recipient is still as the claim left it. If any check fails it writes nothing and answers `stale`. Otherwise, in that commit, it sets the claimed recipients to `attempting` under the fence, extends the lease to 5 minutes from now (`lease_until`), and moves `send_drive` to it. Then it waits for the barrier, so the published state holds `attempting` together with this `lease_until`. No later step extends this lease, so the published `lease_until` bounds every dispatch under the fence. After the publish, Mark re-checks that the fence is still current and the lease still live.
   - **If both hold,** it answers `ok`.
   - **Otherwise** it answers `stale`. If the fence is still current it returns its recipients to `pending` (a newer fence's recipients are never touched); `send()` was never called under this fence. The attempt does not count toward the crash-loop cap. The consumer then acknowledges and never calls `send()`.
3a. **Confirm quota:** confirm the step 2 reservation, re-reserving or calling `delaySend` as step 2 describes. This and the directory lookups of step 4 are the only remote waits after Mark, and all of them finish before the dispatch authorization. The consumer also builds the complete `send()` request here.
4. **Authorize:** RPC `authorizeDispatch(sendId, fence)`. It grants at most one authorization per fence, for one `send()` call.
   - The Durable Object first runs the directory point lookups: the mailbox's owner, and whether `from` is an active identity.
   - Then, in one synchronous step with no await, it checks: the mailbox is not `restoring`; the recovery epoch and `attempt` equal the fence; no authorization was granted under this fence yet; the lease is live; the send is not terminal or `cancelled`; the owner is the submitting user and `from` is active; and every recipient of the request is still `attempting` under this fence.
   - It also refuses (`stale`) when less than `10 s + clockSkew` of the lease remains.
   - **If all hold,** it records on the send that this fence was authorized (a local write; it does not wait for a publish, because the published `lease_until` already bounds the call) and answers `ok` with `remainingMs = 10 s`. The dispatch window therefore ends at least `clockSkew` before `lease_until` on the authorizing object's clock.
   - **Any other answer is `stale`**, and the consumer acknowledges and never calls `send()`. With the current fence and no authorization granted under it, the recipients return to `pending` (`send()` cannot have run). Otherwise they stay `attempting`, and the next claim, after `lease_until`, counts them as ambiguous. **A failed owner or send-as check** ends the send `failed` with `invalid_sender` instead (finish rule).
5. **Send:** the consumer reads its own clock `t0` just before calling step 4, and its dispatch deadline is `t0 + remainingMs`. Because `t0` precedes the Durable Object's check, the deadline is never later than the authorizing object's grant plus 10 s, without comparing the consumer's clock with the object's. Immediately after the answer, with no await between the check and the call, it calls `env.EMAIL.send(…)` only if `Date.now() < deadline`; otherwise it calls `abandonClaim` and sends nothing. A message has at most 50 recipients, so one call covers them all.
   - **Clocks:** the object that later reclaims the recipients may run on another machine (after a migration or a restore), so `lease_until` is compared across clocks there. `clockSkew` (30 s, configuration) bounds that difference: the window ends `clockSkew` before `lease_until` and a reclaim waits until `lease_until + clockSkew`, so any skew below 30 s keeps them apart. The bound is an assumption until M3-0 measures it; if a measured skew exceeds a sixth of `clockSkew`, raise `clockSkew` before M3-5 merges.
   - **What fencing guarantees:** no `send()` call under a fence *starts* after that fence's authorization deadline, and the deadline falls at least `clockSkew` before the `lease_until` that Mark published. A newer claim takes the same recipients only after `lease_until + clockSkew`, including after a restore, which keeps the published `lease_until` (section 2.5). So, with clocks within `clockSkew`, a stale consumer never starts a call after a newer attempt was authorized.
   - **What it cannot guarantee:** the provider has no fencing token and no idempotency key. A call that started in time may still be delivered after a newer attempt's call, and a timed-out call may still deliver. Every such case is an ambiguous event (section 2.6), counted and capped at one extra copy each. An owner change or alias removal that commits after step 4's directory lookups can still be followed by the one call that starts within that authorization's 10 seconds.
   - On a retry to a subset (after a partial failure), each recipient stays in the field it was in (To, Cc or Bcc).
   - If M3-0 shows that `send()` accepts envelope recipients separately from the visible To and Cc lists, the retry keeps the original lists visible. Otherwise the retried copy shows only the retried recipients, which is a recorded limitation.
6. **Record:** RPC `recordResult(sendId, fence, result)`. It never changes a recipient that is already terminal.
   - **The error classes** come from the M3-0 error-code receipt:
     - *Accepted:* `sent` (with `messageId`) or `suppressed`.
     - *Rejected for good* (for example an invalid address): `failed` with a reason.
     - *Not accepted, try later* (rate limit): back to `pending`, with `next_attempt_at` at the backoff. Not counted. The daily-quota error goes through `delaySend`.
     - *Ambiguous* (timeout, connection reset, an unknown 5xx): the message may have been delivered.
       - The recipients go back to `pending`, the metric `send_ambiguous_retry` rises, and the send's ambiguous count goes up.
       - `next_attempt_at` is at least 30 minutes ahead, and the claim enforces it, so 3 ambiguous errors span at least an hour.
       - At 3, the remaining external recipients end `failed` with `delivery_error` (finish rule), and an alert fires.
   - **With the current fence** it records every class, ends the lease and moves `send_drive` to `next_attempt_at` (or to now, for finishing), in one transaction.
   - **With a stale fence** (a restore or a newer claim came in between) it records only `sent` and `suppressed`, because those are confirmed provider facts. It changes no lease and no timer. A stale consumer can therefore never send again, but its confirmed deliveries are kept.
   - **While the mailbox is `restoring`**, the consumer enqueues a **record-only** message and acknowledges.
     - The message carries the result (ids and provider message ids, well under 128 KB), with `delaySeconds` backoff and a hop count.
     - Each hop that still finds the mailbox restoring re-enqueues itself the same way and acknowledges.
     - After 50 hops it is dropped with a metric; the restored send's drive row then re-drives it, within one extra copy.
     - A record-only message never calls `send()`.
   - **Errors before `send()`** (the quota object's RPC, Mark, building the request, `authorizeDispatch`, a missed dispatch deadline): the consumer calls `abandonClaim(sendId, fence, retryAfter)`.
     - With the current fence it returns the claimed recipients to `pending`, ends the lease, and sets `next_attempt_at` and `send_drive` to `retryAfter`, clamped to between 1 minute and 1 hour. It does not count toward any cap.
     - With a stale fence `abandonClaim` and `delaySend` do nothing.
   - **A terminal or `cancelled` send counts as stale for every fence.** Mark, `authorizeDispatch`, `delaySend`, `abandonClaim` and `recordResult` against it change no recipient, lease or timer, and never recreate `send_drive`. Finish rule step 1 also ends any lease, so a consumer that outlived its lease cannot reopen a finished send. The caps and the deadline never fail a recipient that is `attempting` under a lease that expired less than one lease period ago; such a recipient is treated as ambiguous first, so a late but confirmed `sent` is still recorded.
   - **A stale-fence record that leaves every recipient terminal** runs finish rule step 1 itself; the drive handler does the rest.
7. **Finish:** when every recipient is terminal, internal recipients included, the send becomes `sent`, `partial` or `failed` (finish rule), and the sent copy's `send.state` follows.

**The finish rule** applies to every terminal transition: `recordResult`, release step 2, the internal handoff, the claim's or the authorization's `invalid_sender`, the caps, the deadline, and `undoSend` (`cancelled`). **The caps and the deadline apply only to external recipients;** an internal row becomes terminal only through its handoff, so a mixed send that hits a cap still waits for its internal handoffs. Apart from `cancelled` and the release-time failure (which come before any ledger row exists), the finish predicate is that every ledger row, internal and external, is terminal; an internal row is terminal only once its outbox delivery and that delivery's holder exist.
1. Commit the terminal state with `finish_pending`, end any lease, and move `send_drive` to now.
2. Publish (section 2.1) before reporting the state or acting on it.
3. Release the send's own holders: the draft revision's, and the uploads' and forwarded parts' it held (for `cancelled`, only those the restored draft no longer uses). Never the sent copy's index holder (release step 3). Release also the quota reservations of recipients that ended without an accepted or ambiguous `send()`. Each internal delivery keeps the raw object through its own holder, which the inbound pipeline releases after the recipient mailbox has indexed the message.
4. Clear `finish_pending` and delete `send_drive`, in one transaction.

A crash or failed publish anywhere leaves `finish_pending` and the drive row, and the handler resumes at step 2. Every step is idempotent.

**Deadline:** the send keeps a **provider-wait total**: for each rate-limit or ambiguous result recorded under the current fence, the time from that report to its `next_attempt_at`. At 72 hours of provider-wait, the remaining external recipients end `failed` with `delivery_error` (finish rule), and an alert fires.
- Only time the provider caused counts. Quota waits (`delayed`, including the provider's daily-quota error) never count either: they end at a known reset, and the monthly gate can delay a send by weeks with the operator's approval. An outage of our own services (a mailbox not ready or restoring, the queue or the consumer down, crashes) never fails a send.
- **Our own stalls alert instead of failing:** a send that has not reached `send()` within 24 hours of release (not counting time in `delayed`, which M3-6 alerts on separately), or whose leases expired before Mark 5 times in a row, raises an operator alert, once per day.

**Dead-letter queue:** a dead-lettered `send` message only posts a redacted alert to the alert Worker over its service binding, and is acknowledged after the alert answers 2xx. It never changes the send, because the drive row re-drives it. `failed` comes only from recorded failures, the crash-loop cap, the ambiguous-error cap or the deadline.

### 2.5 Restores

- **Fencing:** a restore raises the mailbox's recovery epoch first, so every lease and fence from before it is stale: it can record only confirmed deliveries (section 2.4, consumer step 6), and `authorizeDispatch` refuses it. An authorization handed out before the restore stays bounded by the `lease_until` that Mark published, which the restored state keeps.
- **Epilogue:** in the transaction that finishes the restore, every restored send that is not finished gets its `send_drive` row upserted:
  - at `undoUntil` for `pending`;
  - at `delayedUntil` for `delayed`;
  - at now for everything else, including terminal sends with `finish_pending`. Their queue messages may already be acknowledged.
- **Attempting recipients:** recipients restored as `attempting` stay `attempting`, with their published `lease_until`. The next claim waits until `lease_until + clockSkew` and then treats them as ambiguous; it never sends to them while an authorization from before the restore could still be used.
- **Internal recipients:** rows restored as `pending` are handed off again; the deterministic outbox id makes the repeat a no-op, and the destination is resolved at delivery as usual.
- **No direct enqueue:** the epilogue never enqueues directly; the drive rows do. A crash during or after the epilogue therefore still re-drives every send.

### 2.6 Duplicate policy

`send()` has no idempotency key. This is a deliberate change from the earlier design rule that a retry sends only to recipients still `pending`.
- **A recipient receives a message at least once.** A lost message is the worse failure for personal mail.
- **At most one extra copy per ambiguous event, and at most 3 ambiguous provider errors per send.** An ambiguous event is any point where `send()` may have delivered without a recorded result: a consumer crash or a restore between `send()` and its published result, an ambiguous provider error, or a restore or lease expiry after Mark (the claim cannot tell whether an authorized call started). A crash after Mark and before an authorization is not an ambiguous event: the Durable Object records every authorization, so in the same epoch the claim knows `send()` never ran, and the crash counts only toward the crash-loop cap. After a restore that record may be lost, so every restored `attempting` recipient counts as ambiguous. A crash before Mark is not an ambiguous event. Terminal results are published before they are acknowledged, and a terminal recipient is never changed, so a finished send is never repeated.
- Each occurrence raises the metric `send_ambiguous_retry`, so we measure how often it happens before considering anything stronger.

## 3. Packages

| # | Package | Builder | Tier | Depends on | Size (est) |
|---|---|---|---|---|---|
| M3-0 | Measurements on the approved test route | Sol | T1 | an approved test route | 0.5 to 1 day |
| M3-1 | Timers table and one multiplexed alarm | **Opus** | T0 | inbound mailbox PRs merged | 0.5 to 1 day |
| M3-2 | Drafts, uploads and idempotency in the mailbox | Sol, Opus review | T0 | M3-1 | 1 to 1.5 days |
| M3-3 | Send state machine: `pending_send`, undo, release | **Opus** | T0 | M3-1, M3-2 | 1 to 1.5 days |
| M3-4 | MIME builder and sent copy | Sol, Opus review | T1 | M3-3 | 0.5 to 1 day |
| M3-5 | Send consumer, per-recipient ledger, DLQ | **Opus** | T0 | M3-3, M3-4 | 1 to 1.5 days |
| M3-6 | Account quota gate | Sol, Opus review | T0 | M3-5 | 0.5 day |
| M3-7 | Send-as check and the sender allow-list deploy | **Opus** (check), Sol (CI) | T0 | M3-3 | 0.5 to 1 day |
| M3-8 | Internal delivery (our own recipients) | **Opus** | T0 | M3-5, inbound outbox | 0.5 to 1 day |
| M3-9 | Suppression handling | Sol | T1 | M3-0, M3-5 | 0.5 day |
| M3-10 | From rewriting for group re-sends | Sol, Opus review | T0 | groups designed (not in version 1) | 0.5 day, gated |
| M3-11 | Compose UI on the real send path | Sol | T1 | M3-3, the M2 wiring lane | 0.5 to 1 day |
| M3-12 | End-to-end send matrix | Sol runs, Opus triages | T1 | all above, test route | 1 day |
| M3-13 | Revocable file links for outside recipients (`/f/<token>`) | **Opus** (token and authorisation), Sol (UI) | T0 | M3-2, a contract revision | 1 to 1.5 days |

**Critical path:** M3-1 → M3-2 → M3-3 → M3-5 → M3-8 → M3-12, about 5.5 to 8 working days. M3-0 runs in parallel as soon as a test route is approved. M3-4, M3-6, M3-7 and M3-9 overlap the path.

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
- `alarm()` runs at most 64 due rows per call, then re-arms. It covers: `send_drive` (one row per send, section 2.2), `journal_flush`, `daily_delta`, `weekly_snapshot`, `expiry` (Spam and Trash), `upload_expiry` and `idem_expiry`.
- The mailbox object's existing hourly journal-flush alarm becomes a `journal_flush` row.

**Acceptance:**
- Two timers of different kinds both fire.
- Deleting one timer leaves the other.
- A crash after a handler's commit and before re-arm still fires the remaining timers on the next alarm.
- 1,000 due rows drain in 64-row steps without a skipped row.
- The existing journal-flush tests still pass.

**Stop rule:** if multiplexing would change when the journal flushes (the recovery boundary), stop and write a design note.

### M3-2 Drafts, uploads and idempotency (Sol, Opus review)

**Change:**
- **Drafts:** each revision is an immutable stored object, with a holder registered before its PUT. `If-Match` is checked against the stored revision.
- **Uploads:** streamed to `att/<sha256>/<gen>` with the holder registered first. An `upload_expiry` timer runs 24 h after creation and is cancelled while a draft refers to the upload.
- **Forwarded parts:** a draft's `message` attachment reference registers the draft as a holder of that part's object (or of the source raw object for small parts), so Trash expiry of the source cannot remove it before the draft is sent or deleted.
- **Idempotency:** the `idempotency(scope, key, fingerprint, status, body, created_at)` table stores the fingerprint of contract section 5. Only 2xx results are stored, in the same transaction as the effect. The order is contract section 5's: access, re-authentication, rate limits and the presence of required headers run before the lookup; a committed key replays before any existence or `If-Match` check; existence (404) and `If-Match` (412) run only on a key miss. Rows expire after 24 h.
- **Journal:** draft changes are journalled within the 60-second recovery point.

**Acceptance:** conformance cases 11, 12 and 15 pass against the backend over HTTP in local workerd, and the draft half of case 21 (header text on `createDraft` and `replaceDraft`). Two tabs saving the same draft: one wins, the other gets `revision_mismatch`. A replayed key whose resource is gone (a deleted draft) or whose `If-Match` is no longer current still returns the stored result.

**Stop rule:** no change to the sweeper's holder rules.

### M3-3 Send state machine (Opus)

**Change:** section 2, the `pending` → `queued` steps: `sends` and the ledger insert, the `send_drive` timer and its handler, the finish rule; `sendDraft`, `undoSend`, `listSends`, `getSend` and release.

**Acceptance:**
- Conformance cases 13, 14, 22 and 23 pass against the backend.
- **Lost response:** `sendDraft` commits and its response is dropped; the same-key retry, with the same `If-Match`, returns the send (202, its current state), never 404 or 412, and no second send exists. The same holds for `undoSend` after the restored draft was edited.
- **Owner change or alias removal during the undo window:** the send ends `failed` with `invalid_sender`, with no queue message, no `EMAIL` call and no sent copy.
- **Two sends in one undo window; undo one:** only the other is released.
- **Crash injection** after each release step (the state commit, the PUT, the index commit, `queue.send`): there is always exactly one sent copy and at least one queue message.
- **Restore matrix:** restore during each send state (`pending`, `releasing`, `queued`, `delayed`, `sending`, `sent`, `cancelled`), right after `sendDraft` answered, right after `undoSend` answered, and between `send()` returning and its result being published. After each restore:
  - every accepted send reaches a terminal state, and no undone send goes out;
  - every recipient receives the message at least once, with one extra copy only for the ambiguous case (section 2.6);
  - a draft whose message went out does not reappear, and its sent copy is in Sent;
  - a crash during the epilogue still re-drives every send.
- **Barrier:** with the journal publish failing, `sendDraft` and `undoSend` answer 409 `idempotency_in_progress` with `Retry-After`. A same-key retry after the publish recovers returns the original result. While the publish keeps failing, no queue message and no `EMAIL.send()` happen.
- **Concurrent barriers:** two sends releasing at once in one mailbox both publish without a manifest conflict.
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
- The built request sets no header outside the three above, and never `Bcc`, `Sender`, `From`, `Return-Path` or `Reply-To` from user input; a test lists its header names and counts them (at most 3).
- 50 recipients, 32 attachments and the measured limit are each accepted, and one more of each is refused.

### M3-5 Consumer, ledger and DLQ (Opus)

**Change:** section 2, consumer and dead-letter queue: the `send` queue and its DLQ, `claimSend`, `recordResult`, `delaySend` and `abandonClaim` with fencing, `next_attempt_at`, the caps and the deadline, and the ledger states `pending`, `attempting`, `sent`, `failed` and `suppressed`.

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
  - The deadline or `invalid_sender` ends a send while an earlier consumer is past its lease: that consumer's `delaySend`, `abandonClaim`, Mark and `recordResult` change nothing, and the send stays terminal.
  - After a restore, record-only messages that make every recipient terminal finish the send, with no empty claim and no false alert.
  - Mark failing for 30 minutes leaks no quota reservation; other mailboxes are not delayed.
  - A restore after `send()` and before its result is published: the restored recipients are `attempting`, and the next claim counts them as ambiguous (metric and cap).
  - A stale fence cannot record `failed`, a retry or an ambiguous outcome.
  - A crash after `send()` and before recording resends at most once more and never loses a recipient. The test counts calls per recipient.
  - A partial failure gives `partial` with per-recipient reasons.
  - The quota error gives `delayed` with a timer.
  - A DLQ message never changes the send, and is acknowledged only after the fake alert binding answers 2xx.
  - An alias removed (or the mailbox given to another owner) while a send is `delayed`: the next attempt ends `failed` with `invalid_sender`, with no `EMAIL` call.
  - While the mailbox is `restoring`, the consumer acknowledges without sending and without spending a queue retry; the send goes out after the restore through its timer.
  - A stale fence (after a restore) cannot send, records a confirmed `sent`, and cannot record `failed`; no fence can change a terminal recipient.
  - A record-only message during a long restore re-enqueues itself without dead-lettering.
  - The send's object holders are released only after the terminal state is published.

- **Dispatch fencing,** with a controllable clock in the Durable Object and the consumer, and the fake `EMAIL` counting calls per recipient and fence:
  - The quota confirmation stalls past the lease expiry: `authorizeDispatch` answers `stale`, no `EMAIL` call happens under the old fence, and the next claim sends once.
  - A restore starts while the quota confirmation stalls: `authorizeDispatch` answers `stale` and no `EMAIL` call happens under the old fence. The restored recipients are claimed only after the old published `lease_until`.
  - A restore between `authorizeDispatch` and `send()`: the old call starts before its deadline; the post-restore claim sends only after the old `lease_until` and counts the recipients as ambiguous; each recipient gets at most 2 calls.
  - The mailbox changes owner, or the alias is removed, while the quota confirmation stalls: the send ends `failed` with `invalid_sender`, with no `EMAIL` call.
  - The consumer stalls after `authorizeDispatch` past its deadline: no `EMAIL` call, `abandonClaim`, and the send goes out on the next attempt.
  - Independent clocks: the reclaiming object's clock runs 25 s ahead of the authorizing one, and the authorization is requested near the end of the lease: no two calls for one recipient have overlapping dispatch windows. At 35 s ahead the test documents the overlap that `clockSkew` must exceed.
  - Across all of these, no `EMAIL` call starts after its authorization deadline or under a fence whose `lease_until` has passed.

**Stop rule:** if a confirmed `send()` result cannot be recorded reliably (directly or by a record-only message), stop and report. Do not add sleeps or retries around `send()`.

### M3-6 Quota gate (Sol, Opus review)

**Change:** one quota Durable Object per account counts reserved recipients per quota day and per calendar month.
- **The daily gate** stops at 80% of the daily quota (today 1,000, so 800). That leaves room for the account's other transactional mail, such as password resets, which shares the quota.
- **The monthly gate** stops at the approved spending ceiling: the included 3,000 plus the approved extra spend. It is configuration, never a code constant.
- **When a gate is hit**, the send becomes `delayed` until the reset, and the operator alert fires once per day.
- **Release on failure:** a failed attempt releases its reservation.

**Acceptance:**
- 20 concurrent reservations never exceed the gate.
- Reservations survive an object restart.
- The day and month resets follow M3-0's measured reset time.

### M3-7 Send-as and the allow-list (Opus check, Sol CI)

**Change:**
- **The check:** `from` must be an identity of the mailbox with `sendAs: 'active'`. It is checked on `sendDraft` and again at release, through directory point lookups.
- **The allow-list:** the `send_email` binding's `allowed_sender_addresses` is generated in CI from the directory. A second plain variable from the same source lets `mail-web` mark an identity `active` only once the deployed list contains it.
- **Headers:** a user-supplied `Sender`, `From`, `Return-Path` or `Reply-To` header is never accepted. `Reply-To` comes only from settings or group rules.

**Acceptance:**
- An alias removed during the undo window fails at release with `invalid_sender`.
- An address outside the deployed list is `pending` and refused.
- The CI job's dry run prints counts only.

**Stop rule:** the production deploy job is a workflow change (T0). It runs only after review, and the first production run needs explicit operator approval.

### M3-8 Internal delivery (Opus)

**Change:** a recipient in the same workspace (a directory point lookup at release) gets the sent copy through the inbound outbox, by release step 6. That is one delivery row per send, with the deterministic id `internal:<sendId>` and the internal recipient addresses, referring to the sent raw object, with its own holder registered before the insert. The inbound pipeline resolves the addresses to mailboxes when it delivers, as for inbound mail. The internal ledger rows are journalled and become `sent` only after the insert is acknowledged, and the send finishes only when they are. It makes no `send()` call and uses no quota.
- **Migration:** a `source` column on `deliveries`, with values `inbound` and `internal`.
- **Trust:** the mailbox trusts an internal message's sender only from that column, which only the send path writes. It never trusts a header in the MIME.

**Acceptance:**
- An internal recipient receives the message with no `EMAIL` call.
- An internal To recipient and an internal Bcc recipient each receive a copy with no Bcc addresses in it (the delivered MIME is the stored sent copy, which never has a `Bcc` header).
- An inbound message carrying any "internal" header is still scored as inbound.
- Mixed internal and external recipients each reach a terminal state.
- **Crash after release step 4a and before the outbox insert,** for an internal-only send and for a mixed send whose external recipients are already terminal: the send does not finish, the drive row re-drives the handoff, each recipient mailbox gets exactly one delivery, and the send's own holders are released only after every internal row is `sent`. The raw object exists throughout, and the sent copy's index holder stays as long as its Sent entry.
- **Re-handoff after the pipeline already processed the delivery** (the ledger commit was lost to a restore): the batch writes nothing, no second delivery or holder appears, and the delivery's holder count returns to zero.
- **Owner change or alias removal while the outbox is down:** the internal rows end `failed` with `invalid_sender` and nothing is delivered; after the row was written, the change no longer recalls it.
- **Sending to oneself and to an alias of oneself:** the sender's mailbox has one copy, the sent copy, and no delivery.
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

**Acceptance:** a revoked or expired link answers 404 at once; a token never reveals the mailbox or other files; the download headers follow content-origin section 3.4.

## 4. Done

M3 is done when all of the following hold:
- M3-0 to M3-9, M3-11, M3-12 and M3-13 are merged with their acceptance receipts;
- the conformance suite passes against the backend;
- the end-to-end matrix shows zero lost messages.

M3-10 waits for groups.

## 5. Security review checklist (Opus, high effort)

The security review of M3-2, M3-3, M3-5, M3-6, M3-7, M3-8 and M3-13 checks at least:

1. **Send-as:**
   - `from` cannot be spoofed through a display name, an encoded word or a header.
   - A removed alias or a mailbox given to another member cannot send after the undo window, including a `delayed` send's later attempts; `authorizeDispatch` re-checks both.
   - The allow-list and the app check agree.
2. **Header injection:** a control character is refused with `invalid_header` in every name, address and subject (and with `invalid_request` in file and link names). The recipient count cannot grow through a header. Threading headers stay within `headerValueBytes`.
3. **Cross-mailbox references:**
   - `inReplyTo`, `forwardOf`, `message` attachment parts and uploads resolve only inside the session's mailbox.
   - Idempotency keys are scoped per mailbox.
4. **Durability:**
   - No path loses a send between `pending` and a terminal state.
   - Every holder is registered before its PUT and released only after its index row is gone.
   - Fencing stops a stale consumer from recording a failure or a retry.
   - **Dispatch fencing:** every remote wait after Mark finishes before `authorizeDispatch`; no `send()` starts after its authorization deadline; no deadline is later than the published `lease_until`; a claim never sends to a recipient `attempting` under an unexpired lease of any epoch.
   - **Internal handoffs:** a send finishes only after its internal delivery row and holder exist, written in one batch; the send's own holders are released only then, and the sent copy's index holder only with its index row. The handoff re-checks the owner and send-as before writing. The destination mailbox is resolved at delivery from the current directory, never from a mapping journalled at release.
5. **Quota and cost:** one mailbox cannot exhaust the account's daily quota beyond the gate, and the monthly ceiling cannot be passed by concurrency.
6. **Trust and privacy of copies:** internal delivery is trusted only from the `deliveries.source` column, never from MIME. No stored or delivered MIME contains Bcc recipients.
7. **Secrets and privacy:**
   - No message content, subject, address or token in logs, alerts or errors.
   - `EMAIL` and storage credentials are never echoed.
8. **Input bounds:** every limit in `LIMITS` is enforced server-side before any storage write.
