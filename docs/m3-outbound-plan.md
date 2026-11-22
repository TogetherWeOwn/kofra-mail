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
- **Stop rule for every package:** if a package needs a change to the inbound design decisions (storage keys, holder ordering, journal recovery boundary), stop and write a design note for Opus. Do not adapt them locally.

## 2. Send state machine

```
sendDraft ──► pending ──(undo)──► cancelled
                │ alarm at undoUntil
                ▼
            releasing ──► queued ──► sending ──► sent | partial | failed
                              ▲          │
                              └─ delayed ◄┘  (daily quota reached: timer until reset)
```

**`sendDraft`** runs in one Durable Object transaction:
1. Validate the draft (contract section 8.3).
2. Insert the `sends` row as `pending`. It points at the immutable stored draft revision and its attachment holders.
3. Delete the draft row.
4. Add the timer `send_release` at `undoUntil`.
5. Store the idempotency result.

**`undoSend`** runs in one transaction, and only from `pending`:
1. Set the state to `cancelled`.
2. Delete its own timer row. Other sends' timers are untouched.
3. Restore the draft under its old id with a new revision.

The alarm never enqueues a `cancelled` send, and the consumer re-checks the state before calling `send()`.

**Release** (alarm), in order:
1. **Commit:** `pending` → `releasing`, plus a retry timer at +60 s.
2. **Re-check send-as and limits.** An alias may have been removed during the undo window. A send that now fails the checks becomes `failed` with reason `invalid_sender` or `message_too_large`.
3. **Store the sent copy:** build the MIME of the sent copy, register its holder with the sweeper, and PUT it to object storage (holder before PUT, as on the inbound path).
4. **Commit:** index the sent copy (`sent: true`) and insert the ledger rows (`pending`, one per external recipient). Set `releasing` → `queued`.
5. **Enqueue:** `await SEND.send({ ws, mb, sendId })`, then delete the retry timer.

**If release crashes:**
- A crash at any step leaves the retry timer. The timer runs release again from the committed state. Every step is idempotent: the content-addressed PUT, the holder registration, `INSERT OR IGNORE` of ledger rows.
- So a crash can cause a second queue message. It can never cause zero.

**Consumer** (`mail-send` Worker), in order:
1. **Claim:** RPC `claimSend(sendId)` returns the send request and the `pending` recipients, with a lease of 5 minutes and a fencing counter.
   - It refuses a `cancelled` or terminal send.
   - It refuses a send whose live lease another claim holds; the queue retries later.
2. **Reserve quota:** reserve the recipients in the account's quota object (M3-6). If the quota is exhausted: RPC `delaySend(sendId, until, fence)`, which sets `delayed` and a timer, then acknowledge.
3. **Mark:** set the claimed recipients to `attempting` (with the fence).
4. **Send:** call `env.EMAIL.send(…)` once per message. A message has at most 50 recipients, so one call covers them all.
5. **Record:** RPC `recordResult(sendId, fence, result)`, which sets each recipient to `sent` (with `messageId`), `failed` (with a reason) or `suppressed`. A stale fence cannot record.
6. **Finish:** when every recipient is terminal, the send becomes `sent`, `partial` or `failed`, and the sent copy's `send.state` follows. A transient error returns the `attempting` recipients to `pending` and throws, so the queue retries.

**Duplicate policy:** `send()` has no idempotency key. If the consumer dies after `send()` returns but before `recordResult`, the retry finds those recipients `attempting` under an expired fence and sends to them again.
- So **a recipient may receive a message twice, and never zero times.** A lost message is the worse failure for personal mail.
- The window is one RPC long. Each occurrence raises the metric `send_ambiguous_retry`, so we measure how often it happens before considering anything stronger.

**Dead-letter queue:** a message dead-lettered from `send` sets the send to `failed` (reason `delivery_error`) and posts a redacted alert to the alert Worker over its service binding. The DLQ message is acknowledged only after the alert answers 2xx.

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

**Critical path:** M3-1 → M3-2 → M3-3 → M3-5 → M3-8 → M3-12, about 5.5 to 8 working days. M3-0 runs in parallel as soon as a test route is approved. M3-4, M3-6, M3-7 and M3-9 overlap the path.

### M3-0 Measurements (Sol)

**Acceptance:** a receipt with the raw results for:
- **Size:** the real outbound limit, from sends of 6, 18 and 24 MiB encoded. It sets `LIMITS.outboundMessageBytes`.
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
- **Idempotency:** the `idempotency(scope, key, fingerprint, status, body, created_at)` table stores the fingerprint of contract section 5. Rows expire after 24 h.
- **Journal:** draft changes are journalled within the 60-second recovery point.

**Acceptance:** conformance cases 11, 12 and 15 pass against the backend over HTTP in local workerd. Two tabs saving the same draft: one wins, the other gets `revision_mismatch`.

**Stop rule:** no change to the sweeper's holder rules.

### M3-3 Send state machine (Opus)

**Change:** section 2, the `pending` → `queued` steps: `sends` and the ledger insert; `sendDraft`, `undoSend`, `listSends`, `getSend` and release.

**Acceptance:**
- Conformance cases 13 and 14 pass against the backend.
- **Two sends in one undo window; undo one:** only the other is released.
- **Crash injection** after each release step (the state commit, the PUT, the index commit, `queue.send`): there is always exactly one sent copy and at least one queue message.
- **Undo racing the alarm:** either `cancelled` with no queue message ever, or released with undo answering `send_not_pending`. Never both.

**Stop rule:** if the Durable Object's single-threaded ordering cannot give the undo-or-release guarantee without a lock, stop and redesign. Do not add a timer guess.

### M3-4 MIME builder and sent copy (Sol, Opus review)

**Change:** build the structured `send()` request and the RFC 5322 MIME of the sent copy:
- UTF-8 headers as RFC 2047 encoded words;
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

**Stop rule:** if a confirmed `send()` result cannot be recorded reliably within one RPC, stop and report. Do not add sleeps or retries around `send()`.

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

## 4. Done

M3 is done when all of the following hold:
- M3-0 to M3-9, M3-11 and M3-12 are merged with their acceptance receipts;
- the conformance suite passes against the backend;
- the end-to-end matrix shows zero lost messages.

M3-10 waits for groups.

## 5. Security review checklist (Opus, high effort)

The security review of M3-2, M3-3, M3-5, M3-6, M3-7 and M3-8 checks at least:

1. **Send-as:**
   - `from` cannot be spoofed through a display name, an encoded word or a header.
   - A removed alias cannot send after the undo window.
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
6. **Trust:** internal delivery is trusted only from the `deliveries.source` column, never from MIME.
7. **Secrets and privacy:**
   - No message content, subject, address or token in logs, alerts or errors.
   - `EMAIL` and storage credentials are never echoed.
8. **Input bounds:** every limit in `LIMITS` is enforced server-side before any storage write.
