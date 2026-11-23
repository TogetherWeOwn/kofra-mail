# Mail API contract, version 1

This package holds the wire contract between the Riaklo Mail web app and its backend. It contains TypeScript types, the route table and the conformance suite. It ships no product behaviour.

| File | Contents |
|---|---|
| `src/wire.ts` | Resources, requests and responses |
| `src/service.ts` | `MailService`: one method per route; the fake, the backend and the browser client all implement it |
| `src/routes.ts` | `ROUTES`: method, path, status, idempotency, `If-Match`, access and re-authentication rules per operation |
| `src/errors.ts` | The error catalogue, `Problem` and `MailApiError` |
| `src/limits.ts` | `LIMITS` and `attachmentBudget` |
| `src/harness.ts`, `src/conformance.ts` | The conformance harness and the suite every implementation must pass |

Related design notes are in [`docs/content-origin.md`](../../docs/content-origin.md), which covers formatted bodies, attachments and the image proxy, and [`docs/m3-outbound-plan.md`](../../docs/m3-outbound-plan.md), which covers the send path.

## 1. Decisions

1. **One port, three implementations.** `MailService` is the only interface. The in-memory fake implements it for the demo and tests. The backend serves it at `/api/v1` on the mail app host. A thin browser client implements it over HTTP. The conformance suite runs against the fake in CI. It also runs against the backend over HTTP once the backend serves the API.
2. **The session names the mailbox.** User URLs never carry a mailbox or workspace id. The server resolves the session's account user to exactly one mailbox, so a request cannot address another user's mailbox. Admin routes act only on the session's workspace.
3. **JMAP's data model, plain REST transport.** Ids are opaque. Mailbox listings, `getThread`, `getSession` and `updateThreads` carry the mailbox `state` (section 5 lists them); every change is pushed as the new `state` (section 9). Folders, labels and keywords follow Gmail and JMAP. A JMAP endpoint can be added later without changing the data.
4. **Writes are retry-safe by construction.** Batch updates use set semantics, never toggles. Creates, sends and undo require an `Idempotency-Key`. Draft writes require `If-Match`, so two tabs cannot silently overwrite each other.
5. **The app origin never renders message content.** Formatted bodies, inline images, remote images and attachment downloads come from signed, short-lived URLs on a separate content domain ([content-origin.md](../../docs/content-origin.md)). The API never returns message HTML.
6. **Drive is reached only through per-action grants.** Mail never lists a user's Drive. "Attach from Drive" opens a Drive-hosted picker that returns a `pickId` for the chosen files only. The M2 fake's `listDriveFiles` is a demo stand-in and is not part of this contract.

## 2. Transport

- **Base:** `https://mail.<suite-domain>/api/v1`, same origin as the app. There is no CORS: other origins are refused.
- **Bodies:** `application/json; charset=utf-8`, with camelCase field names. Uploads are the exception: the raw file is the body, with its own `Content-Type`.
- **Dates and sizes:** dates are RFC 3339 UTC strings ending in `Z`. Sizes are integers in bytes.
- **Unknown input:** an unknown request field or query parameter answers 400 `unknown_field`, so a typo never silently does nothing. Clients must ignore unknown response fields.
- **Absent values:** an optional field is omitted, never `null`. `nextCursor` is the exception: it is `null` on the last page.
- **Responses:** every response carries `X-Request-Id`. Every response sets `Cache-Control: no-store`.

## 3. Authentication and session

**The target design depends on I1** (the suite's OpenID Connect provider):
- The app signs in with authorization code plus PKCE against the account host.
- Users are keyed on `(iss, sub)`, never on email.
- The app keeps its own `__Host-` session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`).
- The session records the account session id, the credential epoch and `auth_time`.
- The server re-checks the account session through a private service binding to the account service. The result is cached for at most 60 seconds. Back-channel logout also ends the session at once and closes its live-update sockets.

**Until I1 is live:**
- The backend runs only with a fake session provider.
- That provider is accepted only when the request host is loopback and a development flag is set.
- A production configuration with the fake provider refuses to start.
- No public route serves this API before I1.

**Rules for every request:**
- **`GET /session`** returns the user, mailbox, workspace role, `csrfToken`, `authTime`, `limits`, `features` and `state`. The client calls it first. It answers every signed-in workspace member, including one without a mailbox (then `mailbox` is absent).
- **No session or an expired session:** 401 `unauthenticated`. The client starts sign-in again.
- **CSRF:** every non-GET request must send `X-CSRF-Token` with the session's token. The server also checks `Origin` against the app origin. A failed check answers 403 `csrf_failed`. The token is an HMAC of the session id, so it changes whenever the session does.
- **Mailbox binding:** the user is bound to a mailbox by the directory row created by an admin (`ownerUserId`). The server resolves the mailbox on every request, never from a cached session value, so an owner change takes effect on the next request; it also closes the previous owner's live-update sockets. If the session's user has no mailbox, every user route except `getSession` answers 403 `forbidden`; admin routes still work.
- **Admin:** routes with `access: 'admin'` need `workspace.role === 'admin'`, otherwise 403 `forbidden`.
- **Re-authentication:** routes with `reauth: true` also need `authTime` at most 10 minutes old. Otherwise the server answers 403 `reauth_required` with `maxAgeSeconds: 600`. The client signs in again with `max_age=600` and then retries.
- **Existence is not leaked:** a resource id that is not in the session's mailbox (or workspace, for admin routes) answers 404 `not_found`, exactly like an id that never existed.

## 4. Pagination

- **Cursor only.** A request takes `?limit=` (1 to `pageSizeMax`, default `pageSizeDefault`) and `?cursor=`. The response is `{ items, nextCursor }`; mailbox lists add `state`.
- **No totals.** A response never carries page numbers or totals that need a full scan.
- **Cursors are opaque.** A cursor is valid only with the same query parameters. With any other parameters, or when malformed, it answers 400 `invalid_cursor`.
- **Ordering:** threads sort by `lastDate` descending, then `id` descending. Drafts sort by `updatedAt` descending, then `id`. Sends sort by `createdAt` descending, then `id`. Admin lists sort by address or name, ascending.
- **Pages are keyset-based.** A thread that changes while a client pages may appear on two pages or move above the cursor. Clients deduplicate by `id`.

## 5. Idempotency and concurrency

**`Idempotency-Key`:**
- Routes with `idempotency: 'required'` reject a request without the header with 428 `precondition_required`.
- The key is 1 to 64 characters of `[A-Za-z0-9_-]`. The client makes one key per user action (a UUID) and reuses it on every retry of that action.
- **Order of checks:**
  1. Authentication, CSRF, `access`, re-authentication, feature availability (501), rate limits and missing headers (428).
  2. **A committed key replays here**, before any existence or `If-Match` check: a replayed `sendDraft` succeeds although its draft is gone.
  3. A key in progress answers 409 (below).
  4. Existence (404), `If-Match` (412) and validation, then the effect.
  Answers from steps 1, 3 and 4 are never stored.
- **In progress:** before the operation's first await (for example an upload's streaming PUT), the server writes the key with an in-progress marker. A failed operation deletes the marker; a marker left by a crash expires after 5 minutes.
- The server keeps a key for `idempotencyRetentionSeconds` (24 h), scoped to the mailbox (or the workspace, for admin routes), together with a fingerprint of the operation, path parameters and body. The record commits in the same transaction as the operation's effect.
- **A replay** returns the stored status and body, with `Idempotency-Replayed: true`. One exception: a replayed `sendDraft` returns the send's current state (`getSend`), so a stale `pending` and `undoRemainingMs` are never shown after release.
- **The same key with a different fingerprint** answers 422 `idempotency_key_reused`.
- **A replay while the first request is still running** answers 409 `idempotency_in_progress` with `Retry-After`. This answer also means the operation may already have taken effect (for example a `sendDraft` committed but not yet confirmed durable), so the client retries with the same key until it gets another answer.
- **Only successful (2xx) results are stored.** Any 4xx other than `idempotency_in_progress`, and any 5xx, had no effect, so a retry with the same key runs again; after fixing the request the client may reuse the key or make a new one.
- **One exception, `saveAttachmentToDrive`:** its effect is in Drive, which cannot commit together with Mail's record. A 5xx or a lost response may follow a file Drive already stored, so the server passes Drive a stable operation id, `SHA-256(account user id, mailbox id, key, fingerprint)`, so a same-key request after the mailbox changes owner never maps to the previous owner's file, and Drive deduplicates it durably for at least `idempotencyRetentionSeconds` and returns the original file for it. A same-key retry therefore returns the first file and never creates a second one (section 8.5). **A result that may have taken effect pins the key:** a 5xx after the Drive call started keeps the key bound to its fingerprint for `idempotencyRetentionSeconds`, so a different body under that key answers 422 `idempotency_key_reused` instead of creating a second file, and the same body reconciles through the operation id. Because the effect is in the user's own Drive, this route's keys are scoped to the mailbox **and the account user**: after the mailbox changes owner, the new owner's same key is a new action, never a replay of the previous owner's file.

**`If-Match`:**
- Drafts carry a `revision`. `replaceDraft` and `sendDraft` require `If-Match: <revision>`; `deleteDraft` accepts it.
- A missing header where it is required answers 428 `precondition_required`.
- A revision that is not current answers 412 `revision_mismatch`. The client re-reads the draft and resolves the conflict. The server never merges drafts.

**Naturally idempotent writes:**
- `updateThreads`, `updateSettings`, `renameLabel` and `updateMailbox` set values, so repeating them has the same effect.
- `DELETE` answers 204 whether or not the resource still exists in the session's scope.

**`state`:** exactly the routes with `state: true` in `ROUTES` carry the mailbox `state` as a top-level field: `getSession`, `listViews`, `listThreads`, `getThread`, `listLabels`, `listDrafts`, `listSends` and `updateThreads`. Every value read at the same moment is the same, and any change to the mailbox moves it.
- No other response carries a mailbox `state`, and there is no state header. A `Send`'s own `state` field is its send state, not the mailbox state.
- Other writes return the resource they changed (or 204). The client associates a bare resource with a mailbox state by reading one of the routes above, or from the live-update push of the new `state` (section 9).

## 6. Errors

Errors are RFC 9457 `application/problem+json`, in the same shape as the Kofra API:

```json
{ "type": "urn:kofra-mail:problem:revision_mismatch", "title": "Draft changed elsewhere", "status": 412,
  "code": "revision_mismatch", "requestId": "01J…" }
```

- **`type`** is `urn:kofra-mail:problem:<code>` (`PROBLEM_TYPE_PREFIX`), a stable URI that names no host. A deployment that publishes error pages may configure a documentation base instead, giving `<base><code>`.
- **Switch on `code`.** Clients never use `title` or `detail` for logic. `ERROR_STATUS` in `src/errors.ts` fixes the status of every code.
- **Field errors:** `invalid_request` and `invalid_header` carry `errors: [{ field, code }]`, where `field` is a JSON Pointer such as `/to/3/email`.
- **Limits:** `limit` carries the exceeded bound.
- **Retries:** 429, 503 and 409 `idempotency_in_progress` carry `Retry-After` and `retryAfterSeconds`, a non-negative integer number of seconds.
- **During a restore:** while a mailbox is being restored, its routes answer 503 `mailbox_restoring`. Deliveries meanwhile wait in the queue.
- **Not yet available:** a feature whose dependency is not live (for example Drive before its per-action tokens) answers 501 `feature_unavailable`, and `Session.features` reports it as off.
- **No content in errors:** `detail` never contains message content, other mailboxes' addresses or secrets.

## 7. Routes

`ROUTES` in `src/routes.ts` is normative. This table summarises it. All paths are under `/api/v1`. "Idem" means an `Idempotency-Key` is required.

| Operation | Route | Notes |
|---|---|---|
| `getSession` | `GET /session` | |
| `listViews` | `GET /views` | Unread thread count per view, plus the draft count |
| `listThreads` | `GET /threads?view=&labelId=&q=&tz=&cursor=&limit=` | `view` is required; `q` searches within the view |
| `getThread` | `GET /threads/{threadId}` | At most 100 messages, so it is not paged |
| `updateThreads` | `POST /threads/update` | `{ ids (≤100), set }`; all or nothing |
| `getBodyUrl` | `POST /messages/{messageId}/body-url` | `{ remoteImages }` → signed content URL, for HTML and plain-text messages |
| `getAttachmentUrl` | `POST /messages/{messageId}/attachments/{part}/url` | Signed download URL |
| `saveAttachmentToDrive` | `POST /messages/{messageId}/attachments/{part}/save-to-drive` | Idem; needs `features.drive` |
| `listLabels`, `createLabel`, `renameLabel`, `deleteLabel` | `/labels`, `/labels/{labelId}` | Create is Idem; delete removes the label from every message |
| `listIdentities` | `GET /identities` | Send-as addresses |
| `getSettings`, `updateSettings` | `GET`, `PATCH /settings` | `PATCH` is partial |
| `listDrafts`, `getDraft` | `GET /drafts`, `GET /drafts/{draftId}` | |
| `createDraft` | `POST /drafts` | Idem |
| `replaceDraft` | `PUT /drafts/{draftId}` | Requires `If-Match` |
| `deleteDraft` | `DELETE /drafts/{draftId}` | Accepts `If-Match`; releases the draft's uploads |
| `sendDraft` | `POST /drafts/{draftId}/send` | Idem and `If-Match`; 202 with a `pending` `Send` |
| `listSends`, `getSend` | `GET /sends?active=`, `GET /sends/{sendId}` | Per-recipient status |
| `undoSend` | `POST /sends/{sendId}/undo` | Idem; restores the draft under its old id |
| `createUpload` | `POST /uploads?name=` | Idem; the raw file is the body |
| `deleteUpload` | `DELETE /uploads/{uploadId}` | |
| `importFromDrive` | `POST /drive/imports` | Idem; `{ pickId, mode }` |
| `listDomains`, `addDomain` | `/admin/domains` | Admin; add is Idem and needs re-authentication |
| `listMailboxes`, `createMailbox`, `updateMailbox` | `/admin/mailboxes`, `/admin/mailboxes/{mailboxId}` | Admin; writes need re-authentication |
| `createAlias`, `deleteAlias` | `POST /admin/aliases`, `DELETE /admin/aliases/{address}` | Admin; both need re-authentication |
| `listMembers` | `GET /admin/members` | Admin; workspace members from the account service |

**Not in version 1:**
- groups;
- filters and vacation replies;
- contacts;
- changing the primary domain;
- deleting a mailbox or domain;
- JMAP.

The M2 admin screen's group form stays demo-only until groups are designed.

## 8. Semantics

### 8.1 Folders, views and threads

**Folders and keywords:**
- Each message is in exactly one `folder`: `inbox`, `archive`, `spam` or `trash`.
- `unread`, `starred` and `labelIds` are per message.
- `sent` marks copies written by this mailbox's send path.
- `View` (in `src/wire.ts`) defines when a thread appears in a listing. Summary fields are computed over the thread's qualifying messages.

**`updateThreads`:**
- It applies `set` to every message of each listed thread, and to all threads or none.
- An unknown thread id fails the whole call with 404 `not_found`.
- An unknown label id fails with 400 `invalid_request`.
- Moving messages into `spam` or out of it also trains the mailbox's spam filter ("Report spam" and "Not spam").

**Expiry:**
- A message expires `spamTrashRetentionDays` (30) days after it entered Spam or Trash.
- Moving it out of Spam or Trash cancels the expiry.
- When it expires, the mailbox removes it from the index. Bytes are erased only when storage garbage collection is enabled, so the UI makes no erasure claim.

**Threading:**
- Gmail's rule: the same normalised subject, linked by `In-Reply-To` or `References`, or by our `inReplyTo` on a sent reply.
- A new thread starts after `threadMessages` (100) messages, so `getThread` never pages.

**Message text:**
- `text` holds at most `messageTextBytes` of plain text, with `textTruncated` set when there is more.
- The full message is always available through `getBodyUrl`, for every message. The content origin renders plain-text-only messages as escaped text.

### 8.2 Search

**Where it applies:** `q` filters within `view`. To search all mail, the client sends `view: 'all'`.

**Terms:**
- Terms are separated by spaces; double quotes group a phrase.
- All terms must match the same message.
- A term without an operator matches subject, addresses, the first `searchBodyBytes` of body text and attachment names.

**Operators:**

| Operator | Matches |
|---|---|
| `from:` | sender name or address |
| `to:` | To or Cc name or address |
| `subject:` | subject |
| `label:` | label name (exact, case-insensitive) |
| `has:attachment` | messages with attachments |
| `is:unread`, `is:starred` | the keyword |
| `before:YYYY-MM-DD`, `after:YYYY-MM-DD` | date, at midnight in the time zone given by the `tz` parameter (IANA name); UTC without it |
| `larger:N[k\|m]` | size in bytes |

- An unknown operator is treated as literal text.
- An invalid or empty date or size (`before:`, `larger:`, `larger:huge`) matches nothing; it is not an error and not literal text.
- Matching is case-insensitive, after Unicode NFKC normalisation.

### 8.3 Drafts, send and undo

**Saving a draft:**
- `from` must be one of the user's identities, otherwise 422 `invalid_sender`.
- Recipient and attachment counts may not exceed the send limits.
- Address syntax is not checked, because drafts may be incomplete, but lengths are: an address over `addressBytes` (254), a link URL over `linkUrlBytes` or a link name over `linkNameBytes` answers 400 `invalid_request` (`too_long`).
- **Header text:** a subject, display name or address (and, on admin routes, a mailbox `displayName`, which is the From name of its identities) that contains a control character other than tab (CR and LF included) answers 422 `invalid_header`, with the field in `errors`. It is never stripped. `hasHeaderControl` in `src/headers.ts` is the rule. Link names and URLs with control characters answer 400 `invalid_request`; file names are checked when uploaded (section 8.4).
- `inReplyTo` and `forwardOf` must name messages in this mailbox when first set. When `inReplyTo` is first set, the server copies the parent's `Message-ID` and `References` into the draft, bounded: only ids that pass `isSafeMessageId`, the first and the last 10 (an unsafe parent id is never stored, and the reply then has no `In-Reply-To`), so the reply keeps its threading headers even if the parent later expires. A later `replaceDraft` that carries the same value over stays valid even after the source message expired or was deleted, like an attachment already on the draft.

**Attachment references:**
- `upload`: an unexpired upload of this mailbox.
- `message`: an attachment part of a message in this mailbox (forwarding). Its name is the one the index stored: names from third-party mail and Drive have control characters, `/` and `\` removed when indexed (`indexedAttachmentName`), and the outbound MIME encodes every name that is not a plain token (RFC 2231). The draft holds a reference on that part, so Trash expiry of the source message cannot remove it before the draft is sent or deleted.
- `link`: a credential-free `https:` URL; it is sent as a link in the body and does not count toward `attachmentsPerMessage`.
- **Deferred: revocable file links.** A link to an upload that outside recipients can open (`/f/<token>`, expiring and revocable one by one) is not in version 1; it is a planned M3 package. Until then a draft whose encoded size exceeds `outboundMessageBytes` is refused at send with `message_too_large`, and the client offers to remove files or, when `features.drive` is on, to share them as a Drive link (workspace members only).
- An upload referred to by a draft does not expire.

**`sendDraft` checks** (each a 422 code, except the subject length, 400 `invalid_request`):
- 1 to `recipientsPerMessage` recipients, all syntactically valid (`invalid_recipients`, `too_many_recipients`);
- `from` is an identity with `sendAs: 'active'` (`invalid_sender`);
- file attachments ≤ `attachmentsPerMessage` (`too_many_attachments`);
- encoded size ≤ `outboundMessageBytes` (`message_too_large`, with `limit`);
- header text, again (`invalid_header`), and the subject fits `subjectBytes` (`invalid_request`).

**Threading headers are trimmed, never refused** (`threadingHeaders` in `src/headers.ts`):
- Message-IDs come from third-party mail. An id that is not `<`, printable ASCII without space or angle brackets, then `>` (`isSafeMessageId`) is dropped; an unsafe parent id leaves out `In-Reply-To`.
- `In-Reply-To` is the parent's `Message-ID`.
- `References` keeps the parent's id, then the first id, then the most recent ids, newest first, at most 10 after the first, while its unfolded value fits `headerValueBytes` (2,048). With long legal ids it keeps fewer than 11.
- An id that alone exceeds `headerValueBytes`, or `MESSAGE_ID_MAX` (one RFC 5322 line), is never sent. `References` folds between ids, so every physical line fits 998 octets.
- The provider request sets at most three headers of its own (`In-Reply-To`, `References`, `Reply-To`), each within `headerValueBytes`, well under the platform's limit on custom headers. Every other header comes from the request's structured fields.

**If the checks pass:**
- The draft becomes a `pending` send and leaves the draft list.
- The response is 202 with `undoUntil` (now plus `undoSeconds`) and `undoRemainingMs`.

**`undoSend`:**
- It succeeds while the send is still `pending`. It returns the draft under its original id, with a new revision, and the send becomes `cancelled`.
- The server releases a send no earlier than `undoUntil`. After release, undo answers 409 `send_not_pending`.
- A retried undo with the same key returns the same draft.

**At release** the server checks again that the mailbox has the owner who sent it and that `from` is still an active identity. If either changed during the undo window, the send ends `failed`, each recipient `failed` with reason `invalid_sender`; nothing is sent and no sent copy is written.

**After release:**
- The sent copy appears in this mailbox (`sent: true`, folder `archive`, or `inbox` when sent to oneself) with `send.state`. Bcc recipients are kept only in the sender's index, never in any stored or delivered MIME.
- `getSend` reports per-recipient status: `pending`, `sent`, `failed` or `suppressed`.
- `delayed` means the shared daily sending quota is reached. `delayedUntil` gives the next attempt, and the message is not lost.

### 8.4 Uploads and attachments

**`createUpload`:**
- The body is the file, at most `uploadBytes` (25 MiB). A larger file answers 413 `payload_too_large`.
- `name` is a query parameter, 1 to 255 UTF-8 bytes, with no `/`, `\` or control characters.
- The server streams the bytes to object storage, computes `sha256` and returns the `Upload`.
- An upload no draft refers to is released after `uploadRetentionSeconds` (24 h).

**Downloads:** `getAttachmentUrl` returns a content-origin URL valid for `contentUrlSeconds` (5 minutes). It always downloads as `application/octet-stream` with `Content-Disposition: attachment`, and is never rendered by the app.

**The client's size check:** `attachmentBudget(limits, bodyBytes)` is an estimate that reserves 16 KiB for headers and MIME structure: files within it pass unless the headers are unusually large (for example 50 recipients with long encoded names and many long file names). Above it the client warns, and the server's encoded-size check decides. Files the server refuses can go as a Drive link.

### 8.5 Drive

These routes need `features.drive`, which needs I1's per-action token exchange and Drive accepting those tokens. Until then they answer 501 `feature_unavailable`.

**`importFromDrive`:**
- Flow: the app opens the Drive picker → the picker returns `pickId` by `postMessage`, and the app checks the message origin → the app calls this route.
- The server exchanges the session for a token with audience Drive, the `drive.read` scope, the picked file ids and a lifetime of at most 5 minutes.
- A `pickId` is bound to the account user who chose the files as well as the mailbox. After the mailbox changes owner it answers `not_found` to the new owner.
- `copy` returns uploads. `link` returns link attachments for workspace members.

**`saveAttachmentToDrive`:** uploads the attachment to the user's Drive with a `drive.upload` token for that one action.
- The upload carries the operation id of section 5. Drive must store it with the file, durably, and answer a repeat of the same operation id with the original file instead of a new one.
- **`features.drive` stays off until Drive offers that.** Without it, a lost reply after Drive stored the file would let a retry create a second file.
- Mail writes its in-progress marker, **with the request's fingerprint**, before the Drive call. For this route the marker never simply expires: if no result is stored, it becomes the pin above when its 5 minutes run out, so a crash after Drive stored the file still binds the key to that fingerprint for `idempotencyRetentionSeconds`. A retry after a crash, a 5xx or a lost reply first asks Drive for the operation id's file, before reading the attachment again, so it succeeds even if the source message expired in between; only an unknown operation id reads the attachment and uploads it. Mail then stores the returned file as the result.

### 8.6 Admin

**Domains:**
- `addDomain` registers a `secondary` or `alias` domain as `pending`. Routing and sending turn `active` only after their onboarding. The domain must be a DNS zone the operator controls, which is checked outside this API. Domain names are unique across workspaces; the operator confirms ownership before routing turns on and can release a `pending` domain that another workspace added without owning it.
- A duplicate domain answers 409 `domain_exists`.

**Mailboxes:**
- `createMailbox` needs `ownerUserId` from `listMembers`, an invited or active member without a mailbox.
- The primary address must be on a primary or secondary domain of the workspace (otherwise 422 `domain_not_in_workspace`) and not already used (409 `address_taken`).
- A mailbox is never bound to an account by matching email.

**Aliases:**
- `createAlias` adds an address on a primary or secondary domain. An address on an alias domain is implicit: `x@alias.example` reaches `x@primary.example`.
- At most `aliasesPerMailbox` per mailbox, otherwise 422 `limit_reached`.
- With `sendAs: true`, the alias shows as `pending` in the owner's identities until the sending allow-list is redeployed through CI.
- `deleteAlias` stops delivery to that address at once.

## 9. Live updates

- `GET /api/v1/events` upgrades to a WebSocket on the same session.
- The server sends `{"type":"state","state":"<new state>"}` after any change to the mailbox. The client refetches what it shows.
- The upgrade checks `Origin` against the app origin, like every non-GET request, because `SameSite=Lax` cookies are also sent from sibling same-site hosts.
- The socket carries no message data. It is closed when the session ends or the mailbox changes owner, and the client reconnects with backoff.

## 10. Limits

`LIMITS` in `src/limits.ts` is normative; `GET /session` serves the values in force. The main ones:

| Limit | Value | Source |
|---|---|---|
| Inbound message | 25 MiB | Cloudflare Email Service |
| Outbound message (encoded) | 5 MiB until measured; the documented values are 5 and 25 MiB | Email Service docs disagree; the outbound size test sets it |
| Recipients / file attachments per message | 50 / 32 | Email Service |
| Custom header value | 2,048 bytes, unfolded; References is trimmed to fit | Email Service |
| Upload | 25 MiB per file | matches inbound |
| Subject / body / signature | 998 / 1 MiB / 10 KiB UTF-8 bytes | RFC 5322 line length; contract bounds |
| Address / link URL / link name in a draft | 254 / 2,048 / 255 UTF-8 bytes | RFC 5321 path length; contract bounds |
| Label name / labels per message / per mailbox | 72 characters / 64 / 1,000 | contract bounds; the per-message limit is the mailbox journal's |
| Aliases per mailbox | 30 | Google Workspace's limit, so imported directories fit |
| Thread size | 100 messages | threading rule |
| Page size | default 50, maximum 100 | contract |
| Batch update | 100 threads | contract |
| Query / indexed body | 512 bytes / first 64 KiB | contract; the search design |
| Message text in a response | 64 KiB | contract; the full text is on the content origin |
| Idempotency keys / unattached uploads kept | 24 h / 24 h | contract |
| Content URL lifetime | 5 minutes | content-origin design |
| Remote image | 5 MiB, at most 3 redirects | content-origin design |
| Spam and Trash retention | 30 days | product |

## 11. Conformance

`defineConformance(name, makeHarness)` in `src/conformance.ts` registers the suite with `node:test`. An implementation passes when every case passes:
- `packages/mail-core` runs the suite against the fake in CI;
- the backend runs it over HTTP against local workerd once it serves `/api/v1`.

The suite checks `MailService`, which has no headers. The HTTP client's own tests check the wire: `Retry-After` equals `retryAfterSeconds`, `X-Request-Id` and `Cache-Control: no-store` are present, problem bodies have `application/problem+json`, and `X-CSRF-Token`, `Idempotency-Key` and `If-Match` are sent as `ROUTES` requires.

Every failure's `type` is checked against the harness's `problemTypePrefix` (default `PROBLEM_TYPE_PREFIX`), and content URLs must carry an integer `ep` (equal to `credentialEpoch` when the harness provides it). Every call's result is also checked for `state`: present on exactly the routes with `state: true`, and absent elsewhere (a `Send`'s own send state excepted).

The harness (`src/harness.ts`) provides sessions for six principals in two workspaces, inbound delivery (with an optional `Message-ID`), a clock, the content origin, the stored header fields of a sent copy (`sentHeaders`), and, where Drive is a local stand-in, Drive fault injection (`driveFaults`). Each case gets a fresh harness. Content URLs follow the format of [content-origin.md](../../docs/content-origin.md) section 2.1, so the suite decodes their claims (it does not verify the MAC; tampering and expiry are the content Worker's own acceptance tests). Cases:

1. **Session:** `getSession` has the member's mailbox, `role: 'member'`, a non-empty `csrfToken` and every `LIMITS` key. The primary address is an identity with `primary: true`. `newAdmin` gets a session with no `mailbox`, gets `forbidden` on `listThreads`, and can call `listMembers` and `createMailbox` for itself.
2. **JSON:** every result of every call in this suite equals its own `JSON.parse(JSON.stringify(…))`, and has no `null` except `nextCursor`.
3. **Errors:** every failure is a `MailApiError` whose `code` is in the catalogue and whose `status` equals `ERROR_STATUS[code]`.
4. **Listing:**
   - Threads in `inbox` sort by `lastDate` and then `id`, both descending.
   - Walking with `limit: 1` returns each thread exactly once, and the last page has `nextCursor: null`.
   - `limit: 0` and `limit: pageSizeMax + 1` answer `invalid_request`.
   - A garbage cursor, or a cursor reused with another `view`, answers `invalid_cursor`.
5. **Conversation:**
   - `getThread` returns the delivered message with its attachments (`part`, `name`, `size`).
   - Text longer than `messageTextBytes` is cut to that size, with `textTruncated: true`.
   - An unknown id answers `not_found`.
6. **Isolation:**
   - Ids of `member`'s thread, message, draft, upload, label and send answer `not_found` to `other` on reads.
   - On writes too: `other`'s `updateThreads`, `getAttachmentUrl`, `saveAttachmentToDrive` (when `features.drive`; otherwise `feature_unavailable` comes first), `replaceDraft`, `sendDraft`, `undoSend` and `renameLabel` on those ids answer `not_found`; `other`'s `deleteDraft`, `deleteLabel` and `deleteUpload` answer 204, and the resource still exists for `member` afterwards.
   - `other`'s `createDraft` naming `member`'s message in `inReplyTo`, `forwardOf` or a `kind: 'message'` attachment answers `not_found`.
   - `other`'s lists do not contain them.
   - A message delivered to `other` never appears for `member`.
   - `foreignAdmin`'s `updateMailbox` and `createAlias` with W1 mailbox ids answer `not_found`; its `deleteAlias` of a W1 alias answers 204 and the alias still exists; its lists contain nothing of W1.
7. **Thread updates:**
   - Moving to `trash` shows the thread in `trash` with `expiresAt` 30 days ahead, and removes it from `inbox` and `all`.
   - Repeating the same update gives the same result.
   - Labels can be added and removed.
   - A batch with one unknown id answers `not_found` and changes nothing.
   - 101 ids answers `invalid_request`.
   - `listViews` unread counts follow `unread` changes.
8. **Expiry:** after `advance(30 days)`, a thread moved to Trash is gone, and a thread moved back out of Trash before then is kept.
9. **Search:**
   - `from:`, `subject:`, `has:attachment`, `label:` and `is:unread` each select exactly the expected fixture threads.
   - A quoted phrase matches only adjacent words.
   - A query over `queryBytes` answers `invalid_request`.
10. **Labels:**
    - Create → list → rename → delete works, and delete removes the label from threads.
    - A duplicate name (case-insensitive) answers `label_exists`.
    - An empty name, or one over 72 characters, answers `invalid_request`.
11. **Idempotency:** on `createLabel`, `createDraft` and `createUpload`:
    - replaying a key returns an equal result and creates nothing new;
    - the same key with another body answers `idempotency_key_reused`;
    - a missing key (forced past the types) answers `precondition_required`.
12. **Drafts:**
    - `createDraft` returns a `revision`, and `replaceDraft` with it returns a new one.
    - `replaceDraft` with the old revision answers `revision_mismatch`.
    - `replaceDraft` without `If-Match` answers `precondition_required`.
    - `from` outside the identities answers `invalid_sender`.
    - `deleteDraft` twice gives 204 both times, and the draft leaves `listDrafts`.
13. **Send checks:**
    - 0 recipients or a malformed address answers `invalid_recipients`; 51 recipients answers `too_many_recipients`.
    - 33 file attachments answers `too_many_attachments`.
    - A file of exactly `attachmentBudget(limits, bodyBytes)` bytes passes the size check; a file whose base64 alone exceeds `outboundMessageBytes` answers `message_too_large` with `limit`.
    - A stale `If-Match` answers `revision_mismatch`.
14. **Send and undo:**
    - `sendDraft` returns `state: 'pending'`, `undoUntil` equal to now plus `undoSeconds`, and the draft leaves `listDrafts`.
    - `undoSend` returns the draft under the same id, and the send becomes `cancelled`. Replaying the undo with the same key returns the same draft.
    - Replaying `sendDraft` with its key returns the same send id and creates no second send; after release, the replay reports the current state with `undoRemainingMs: 0`.
    - **Two sends in one undo window:** undo one; after `advance(undoSeconds)` only the other leaves `pending`. Its sent copy is in view `sent` with `sent: true`, and undoing it answers `send_not_pending`.
15. **Uploads:**
    - `uploadBytes + 1` bytes answers `payload_too_large`.
    - An unattached upload is gone after `advance(24 h)`, and a draft that refers to it then answers `not_found`.
    - An upload referred to by a draft survives the same advance.
    - A forward draft (`forwardOf` plus a `kind: 'message'` attachment) of a message moved to Trash survives `advance(30 days)`: `replaceDraft` carrying the same values still succeeds, the draft sends, and `getAttachmentUrl` works on the sent copy's attachment.
16. **Settings:**
    - A partial `updateSettings` changes only the given fields.
    - A `defaultFrom` that is not an active identity answers `invalid_sender`.
    - `undoSeconds: 7` answers `invalid_request`.
17. **Content URLs:**
    - For an HTML message, `getBodyUrl` returns an `https:` URL (or loopback `http:` in tests) on `contentOrigin`, never on the app origin, with `expiresAt` at most `contentUrlSeconds` ahead.
    - Decoded claims: purpose `body`, the message id, the session's mailbox and `ri` equal to the `remoteImages` asked for; `exp - iat ≤ contentUrlSeconds`.
    - A text-only message also gets a `body` URL.
    - `getAttachmentUrl` returns a URL on `contentOrigin` with purpose `att` and the part; an unknown part answers `not_found`.
18. **Admin access:**
    - `member` gets `forbidden` on every admin operation.
    - `staleAdmin` gets `reauth_required`, with `maxAgeSeconds: 600`, on every admin operation with `reauth: true`.
19. **Admin directory:**
    - `addDomain` gives `pending` states, and a duplicate answers `domain_exists`.
    - `createMailbox` on an unknown domain answers `domain_not_in_workspace`, and an address in use answers `address_taken`.
    - `createAlias` with `sendAs: true` appears in the owner's `listIdentities` (owner session) with `kind: 'alias'`.
    - The 31st alias answers `limit_reached`.
    - After `deleteAlias`, the identity is gone.
    - After `updateMailbox` moves mailbox A to the invited member, `member`'s next `listThreads` answers `forbidden`.
20. **Drive** (only if `features.drive`): `importFromDrive` with `harness.drivePick()` in `copy` mode returns upload attachments usable in a draft. Otherwise it answers `feature_unavailable`. With `driveFaults`: a save that crashes Mail after Drive stored the file answers `idempotency_in_progress` until its marker lapses, then the key is pinned (another part answers `idempotency_key_reused`) and the same request returns the one file. A `saveAttachmentToDrive` whose reply is lost after Drive stored the file answers `unavailable`; the same key with another part then answers `idempotency_key_reused`; after the source expires from Trash, the same-key retry still returns that file, Drive holds exactly one new file, and a new key answers `not_found`. After a successful save, a same-key save by the mailbox's next owner makes a different file, and the original owner's replay returns the original. A pick issued to `member` answers `not_found` to the next owner.
21. **Header text and threading:**
    - CR, LF or NUL in a subject, display name, `from` or address answers `invalid_header` with the field, on `createDraft` and `replaceDraft`, and the draft is unchanged, even when the text is also too long; so do CR LF in a mailbox `displayName` and a trailing LF in an alias address. Controls are checked on the raw text, before trimming or length checks.
    - A reply in a thread of 12 messages with legal 200-byte `Message-ID`s: the sent copy's `In-Reply-To` is the parent, and its `References` fits `headerValueBytes`, starts with the first id, ends with the parent, keeps chain order and holds 10 ids.
    - The sent copy has no `Bcc` header and no Bcc address, and every value `sentHeaders` returns is unfolded, including a To list with a long encoded name.
    - A reply to a message whose `Message-ID` carries CR and a `Bcc:` line has neither threading header.
    - An address containing `,`, `<` or `>` answers `invalid_recipients` at send, and a long ASCII display name with `"`, `,` and `<…>` stays one recipient.
22. **Owner change before release:** a send made just before an admin moves the mailbox to another member ends `failed` with `invalid_sender` for each recipient, with no sent copy.
23. **State:** the routes with `state: true` report the same value at the same moment; a delivery, a label, a thread update, a draft and a send each move it.

## 12. Moving the M2 UI to this contract

The M2 UI calls `MailApi` in `@kofra/mail-core`, an in-process port that predates this contract. The wiring lane replaces it with `MailService` and then removes `MailApi` and its fake.

| `MailApi` | `MailService` | Change |
|---|---|---|
| `listMailboxes` | `listViews` | Folders become views; `drafts` is a count |
| `listThreads(filter)` | `listThreads(query)` | Paged; `mailboxId` becomes `view`; `starred` becomes `view: 'starred'` |
| `Thread.mailboxId` | `ThreadSummary.folders` | A thread can span folders |
| `updateThread(id, …)` | `updateThreads({ ids, set })` | One call for a multi-selection; labels add and remove |
| `getMessageContent` | `getBodyUrl` | Returns `{ url, expiresAt }`; re-mint after expiry |
| `downloadAttachment` (Blob) | `getAttachmentUrl` | Download from the content origin; no blob on the app origin |
| `saveDraft` | `createDraft` / `replaceDraft` | Idempotency key on create, `If-Match` on replace |
| `discardDraft` | `deleteDraft` | |
| `listDrafts` | `listDrafts` | Paged |
| `send(draft)` | `replaceDraft`, then `sendDraft` | `undoRemainingMs` drives the toast |
| `undoSend` | `undoSend` | Takes an idempotency key |
| `uploadAttachment` | `createUpload` | Returns `Upload`; the draft refers to it by id |
| `releaseAttachment` | `deleteUpload` | |
| `listDriveFiles`, `attachFromDrive` | `importFromDrive` | The Drive-hosted picker replaces the in-app list |
| `saveToDrive(id)` | `saveAttachmentToDrive(messageId, part)` | |
| `listLabels`, `createLabel(name)` | `listLabels`, `createLabel({ name }, { idempotencyKey })` | Create takes an idempotency key |
| `listIdentities` | `listIdentities` | Returns `{ items }`; each identity has `kind` and `sendAs` |
| `listUsers` | `listMailboxes` | Paged; aliases included |
| `addUser` | `createMailbox` | Needs `ownerUserId` from `listMembers` |
| `listDomains`, `addDomain(name, kind)` | `listDomains`, `addDomain` | Only `secondary` or `alias`; the primary domain is set when the workspace is created |
| `getSettings`, `updateSettings` | `getSettings`, `updateSettings` | `PATCH` is partial |
| `addAlias(userEmail, alias)` | `createAlias({ mailboxId, address, sendAs })` | |
| `listGroups`, `addGroup` | not in version 1 | Demo-only |
