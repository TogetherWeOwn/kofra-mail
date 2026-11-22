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
- **Restores are fenced and resume sending through timers** (section 2.4), following the inbound recovery rules: a restore raises the mailbox's recovery epoch, runs in resumable slices, and "restoring" or "not ready" never spends an attempt or ends in `failed`.
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
| `recordResult` with a terminal outcome returns | A restore cannot rewind a finished send and send it again |
| Releasing the send's object holders | A restored, not-yet-terminal send never points at deleted objects |

An idempotent replay of `sendDraft` or `undoSend` also waits until the original commit is published, so a lost response cannot hand out an unpublished result. If a publish fails, the step answers a retryable error (`unavailable`, `Retry-After`) or, inside the alarm, stops and leaves its retry timer. Cost: about four journal writes per send.

### 2.2 Writes from the API

**`sendDraft`** runs in one Durable Object transaction, then waits for the barrier:
1. Validate the draft (contract section 8.3).
2. Insert the `sends` row as `pending`. It points at the immutable stored draft revision and its attachment holders.
3. Delete the draft row. Steps 2 and 3 are one journal event, so a restore replays both or neither.
4. Add the timer `send_release` at `undoUntil`.
5. Store the idempotency result.

**`undoSend`** runs in one transaction, only from `pending`, then waits for the barrier:
1. Set the state to `cancelled`.
2. Delete its own timer row. Other sends' timers are untouched.
3. Restore the draft under its old id with a new revision (one journal event with step 1).
4. Store the idempotency result, so a retry after a lost response returns the restored draft.

The alarm never enqueues a `cancelled` send, and the consumer re-checks the state before calling `send()`.

### 2.3 Release and the consumer

**Release** (alarm), in order:
1. **Commit:** `pending` → `releasing`, plus a `send_retry` timer at +60 s. The commit fixes the message's `Date` and derives the MIME boundary and our `Message-ID` from `sendId`, so a rerun builds identical bytes and the content-addressed key does not change. If M3-0 shows the provider replaces `Message-ID`, the index records the delivered id for threading; the stored bytes keep ours.
2. **Re-check send-as and limits.** An alias may have been removed during the undo window. A send that now fails the checks becomes `failed` with reason `invalid_sender` or `message_too_large`.
3. **Store the sent copy:** build the MIME of the sent copy, register its holder with the sweeper, and PUT it to object storage (holder before PUT, as on the inbound path). The stored MIME never contains a `Bcc` header; Bcc recipients live only in the `sends` row and the sender's index.
4. **Commit:** index the sent copy (`sent: true`) and insert the ledger rows (`pending`, one per external recipient). Set `releasing` → `queued`.
4a. **Barrier:** publish up to this commit. If the publish fails, stop; the retry timer runs release again.
5. **Enqueue:** `await SEND.send({ ws, mb, sendId, attempt })`, then delete the retry timer.

A crash at any step leaves the retry timer, which runs release again from the committed state. Every step is idempotent: the content-addressed PUT, the holder registration, `INSERT OR IGNORE` of ledger rows. So a crash can cause a second queue message, never zero.

**Consumer** (`mail-send` Worker), in order:
1. **Claim:** RPC `claimSend(sendId)` returns the send request and the recipients still `pending`, with a lease of 5 minutes and a **fence = (recovery epoch, claim counter)**.
   - It refuses a `cancelled` or terminal send (the consumer acknowledges).
   - **Not now** (the mailbox is `restoring` or not ready, or another live lease holds the send): the consumer acknowledges without throwing, so queue retries are never spent on waiting. The Durable Object already holds a `send_retry` timer at the lease expiry or the restore's end, which re-drives the send.
   - **On every attempt** it repeats the send-as check (`from` is still an active identity of the mailbox) and checks that the mailbox still has the same owner. A `delayed` send can wait hours, so release-time checks are not enough. A failed check ends the send `failed` with `invalid_sender`.
2. **Reserve quota:** reserve the recipients in the account's quota object (M3-6). If the quota is exhausted: RPC `delaySend(sendId, until, fence)`, which sets `delayed` and a `send_delayed` timer, then acknowledge.
3. **Mark:** set the claimed recipients to `attempting` under the fence.
4. **Send:** call `env.EMAIL.send(…)` once per message. A message has at most 50 recipients, so one call covers them all. On a retry to a subset (after a partial failure), each pending recipient stays in the field it was in (To, Cc or Bcc). If M3-0 shows that `send()` accepts envelope recipients separately from the visible To and Cc lists, the retry keeps the original lists visible; otherwise the retried copy shows only the retried recipients, which is a recorded limitation.
5. **Record:** RPC `recordResult(sendId, fence, result)`.
   - With the current fence it records every outcome: `sent` (with `messageId`), `failed` (with a reason) or `suppressed`.
   - With a stale fence (a restore or a newer claim came in between) it still records `sent` and `suppressed` for recipients that are not yet terminal, because those are confirmed provider facts, and ignores `failed`. A stale consumer can therefore never send again, but its confirmed deliveries are kept.
   - If the mailbox is `restoring`, the consumer enqueues a **record-only** message carrying the result (ids and provider message ids, well under 128 KB) and acknowledges. The record-only message retries `recordResult` and never calls `send()`.
6. **Finish:** when every recipient is terminal, the send becomes `sent`, `partial` or `failed`, the sent copy's `send.state` follows, and the barrier publishes before `recordResult` returns. Only then are the send's object holders released. A transient provider error returns the `attempting` recipients to `pending`, sets a `send_retry` timer with capped backoff and acknowledges; only real failures (for example a permanent rejection) count toward a recipient's attempt limit.

**Dead-letter queue:** a dead-lettered `send` message posts a redacted alert to the alert Worker over its service binding, and is acknowledged only after the alert answers 2xx. It sets the send `failed` (reason `delivery_error`) only if the mailbox is not `restoring`, no live lease holds the send, and the message's `attempt` is the send's current attempt. Otherwise the send is left to its timers. A dead-lettered record-only message never sets `failed`; its alert asks for an operator re-drive.

### 2.4 Restores

- **Fencing:** a restore raises the mailbox's recovery epoch first, so every lease and fence from before it is stale (section 2.3, consumer step 5).
- **Epilogue, in the transaction that finishes the restore:** for every restored send insert a timer row: `send_release` at `undoUntil` for `pending`; `send_retry` now for `releasing`, `queued` and `sending` (their queue messages may already be acknowledged); `send_delayed` at `delayedUntil` for `delayed`. Recipients restored as `attempting` return to `pending`. The epilogue never enqueues directly: timers do, through the same idempotent path as release step 5, so a crash during or after the epilogue still re-drives every send.

### 2.5 Duplicate policy

`send()` has no idempotency key. This is a deliberate change from the earlier design rule that a retry sends only to recipients still `pending`.
- **A recipient receives a message at least once.** A lost message is the worse failure for personal mail.
- **One extra copy per ambiguous event.** An ambiguous event is a consumer crash, or a restore, between `send()` returning and its result being published. Then the recipient is still `pending` or `attempting` after recovery, and the next attempt sends again. Terminal results are published before they are acknowledged, so a finished send is never repeated.
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

**Stop rule:** at most 20 sends, only to the approved test addresses. If a result contradicts the contract (for example the limit is under 5 MiB), stop and report it.

### M3-1 Timers (Opus)

**Change:** the `timers(due_at, kind, ref)` table, primary key `(kind, ref)` and indexed on `due_at`. The alarm is always the earliest `due_at`.
- `alarm()` runs at most 64 due rows per call, then re-arms. It covers: `send_release`, `send_retry`, `send_delayed`, `journal_flush`, `daily_delta`, `weekly_snapshot`, `expiry` (Spam and Trash), `upload_expiry` and `idem_expiry`.
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
- **Idempotency:** the `idempotency(scope, key, fingerprint, status, body, created_at)` table stores the fingerprint of contract section 5. Only 2xx results are stored, in the same transaction as the effect; pre-checks (`If-Match`, re-authentication, rate limits) run before the record. Rows expire after 24 h.
- **Journal:** draft changes are journalled within the 60-second recovery point.

**Acceptance:** conformance cases 11, 12 and 15 pass against the backend over HTTP in local workerd. Two tabs saving the same draft: one wins, the other gets `revision_mismatch`.

**Stop rule:** no change to the sweeper's holder rules.

### M3-3 Send state machine (Opus)

**Change:** section 2, the `pending` → `queued` steps: `sends` and the ledger insert; `sendDraft`, `undoSend`, `listSends`, `getSend` and release.

**Acceptance:**
- Conformance cases 13 and 14 pass against the backend.
- **Two sends in one undo window; undo one:** only the other is released.
- **Crash injection** after each release step (the state commit, the PUT, the index commit, `queue.send`): there is always exactly one sent copy and at least one queue message.
- **Restore matrix:** restore during each send state (`pending`, `releasing`, `queued`, `delayed`, `sending`, `sent`, `cancelled`), right after `sendDraft` answered, right after `undoSend` answered, and between `send()` returning and its result being published. After each restore:
  - every accepted send reaches a terminal state, and no undone send goes out;
  - every recipient receives the message at least once, with one extra copy only for the ambiguous case (section 2.5);
  - a draft whose message went out does not reappear, and its sent copy is in Sent;
  - a crash during the epilogue still re-drives every send.
- **Barrier:** with the journal publish failing, `sendDraft` and `undoSend` answer `unavailable`, and no queue message and no `EMAIL.send()` happen.
- **Concurrent barriers:** two sends releasing at once in one mailbox both publish without a manifest conflict.
- **Undo racing the alarm:** either `cancelled` with no queue message ever, or released with undo answering `send_not_pending`. Never both.

**Stop rule:** if the Durable Object's single-threaded ordering cannot give the undo-or-release guarantee without a lock, stop and redesign. Do not add a timer guess.

### M3-4 MIME builder and sent copy (Sol, Opus review)

**Change:** build the structured `send()` request and the RFC 5322 MIME of the sent copy:
- UTF-8 headers as RFC 2047 encoded words;
- the text part in quoted-printable or base64, whichever is smaller, so it is never larger than base64 (the client's `attachmentBudget` relies on this);
- `multipart/mixed` with a `text/plain` part and base64 attachments;
- `In-Reply-To`, and `References` trimmed to the first id and the last 10;
- the encoded size, which is the server's `message_too_large` check.

**Acceptance:**
- Golden-file tests.
- Parsing the output back with PostalMime gives the same addresses, subject, text and attachment bytes.
- CR or LF in any name, subject or address is rejected before building, never stripped silently.
- 50 recipients, 32 attachments and the measured limit are each accepted, and one more of each is refused.

### M3-5 Consumer, ledger and DLQ (Opus)

**Change:** section 2, consumer and dead-letter queue: the `send` queue and its DLQ, `claimSend`, `recordResult` and `delaySend` with fencing, and the ledger states `pending`, `attempting`, `sent`, `failed` and `suppressed`.

**Acceptance:**
- With the fake `EMAIL` binding:
  - A retry sends only to `pending` recipients.
  - A stale fence cannot record.
  - A crash after `send()` and before recording resends at most once more and never loses a recipient. The test counts calls per recipient.
  - A partial failure gives `partial` with per-recipient reasons.
  - The quota error gives `delayed` with a timer.
  - A DLQ message sets `failed`, and is acknowledged only after the fake alert binding answers 2xx.
  - An alias removed (or the mailbox given to another owner) while a send is `delayed`: the next attempt ends `failed` with `invalid_sender`, with no `EMAIL` call.
  - While the mailbox is `restoring`, the consumer acknowledges without sending and without spending a queue retry; the send goes out after the restore through its timer.
  - A stale fence (after a restore) cannot send, records a confirmed `sent`, and cannot record `failed`.
  - A message dead-lettered while the mailbox is restoring, or while a live lease holds the send, does not set `failed`.
  - The send's object holders are released only after the terminal state is published.

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

**Change:** a recipient in the same workspace (a directory point lookup) gets the sent copy through the inbound outbox. That is a delivery row per recipient mailbox, referring to the sent raw object, with its own holder. It makes no `send()` call and uses no quota.
- **Migration:** a `source` column on `deliveries`, with values `inbound` and `internal`.
- **Trust:** the mailbox trusts an internal message's sender only from that column, which only the send path writes. It never trusts a header in the MIME.

**Acceptance:**
- An internal recipient receives the message with no `EMAIL` call.
- An internal To recipient and an internal Bcc recipient each receive a copy with no Bcc addresses in it (the delivered MIME is the stored sent copy, which never has a `Bcc` header).
- An inbound message carrying any "internal" header is still scored as inbound.
- Mixed internal and external recipients each reach a terminal state.

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
- one message each to Gmail, Outlook.com, iCloud and Yahoo test accounts;
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
   - A removed alias cannot send after the undo window, including a `delayed` send's later attempts.
   - The allow-list and the app check agree.
2. **Header injection:** CR or LF is rejected in every name, address, subject and file name. The recipient count cannot grow through a header.
3. **Cross-mailbox references:**
   - `inReplyTo`, `forwardOf`, `message` attachment parts and uploads resolve only inside the session's mailbox.
   - Idempotency keys are scoped per mailbox.
4. **Durability:**
   - No path loses a send between `pending` and a terminal state.
   - Every holder is registered before its PUT and released only after its index row is gone.
   - Fencing stops a stale consumer from recording.
5. **Quota and cost:** one mailbox cannot exhaust the account's daily quota beyond the gate, and the monthly ceiling cannot be passed by concurrency.
6. **Trust and privacy of copies:** internal delivery is trusted only from the `deliveries.source` column, never from MIME. No stored or delivered MIME contains Bcc recipients.
7. **Secrets and privacy:**
   - No message content, subject, address or token in logs, alerts or errors.
   - `EMAIL` and storage credentials are never echoed.
8. **Input bounds:** every limit in `LIMITS` is enforced server-side before any storage write.
