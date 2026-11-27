-- Provider results the send consumer could not record on the mailbox at once
-- (docs/m3-outbound-plan.md, section 2.4, step 6). Ids, recipient indexes and
-- provider message ids only: never addresses or content. A row is deleted only
-- after the mailbox recorded it and a publish covered it. The CHECKs match the
-- mailbox's own validation, so a row it would refuse is refused when written.
CREATE TABLE send_results (
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL CHECK (typeof(fence_epoch) = 'integer' AND fence_epoch >= 0),
  fence_attempt INTEGER NOT NULL CHECK (typeof(fence_attempt) = 'integer' AND fence_attempt >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('accepted', 'rejected', 'try_later', 'outage', 'ambiguous')),
  -- The provider's message id of an accepted call (printable ASCII, at most 998
  -- bytes); null when it returned none.
  message_id TEXT CHECK (message_id IS NULL OR (kind = 'accepted' AND length(message_id) BETWEEN 1 AND 998
    AND NOT message_id GLOB '*[^ -~]*')),
  -- A rejection's reason ([a-z][a-z0-9_]*), or the error code of an outage
  -- (required) or an ambiguous result (optional) ([A-Za-z0-9_.-]*), 1 to 64 bytes.
  detail TEXT CHECK (
    (kind IN ('accepted', 'try_later') AND detail IS NULL) OR
    (kind = 'rejected' AND detail IS NOT NULL AND length(detail) BETWEEN 1 AND 64 AND detail GLOB '[a-z]*' AND NOT detail GLOB '*[^a-z0-9_]*') OR
    (kind IN ('outage', 'ambiguous') AND detail IS NOT NULL AND length(detail) BETWEEN 1 AND 64 AND NOT detail GLOB '*[^A-Za-z0-9_.-]*') OR
    (kind = 'ambiguous' AND detail IS NULL)),
  -- The recipient indexes (0 to 49) the provider reported suppressed, as a bit mask.
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (typeof(suppressed) = 'integer' AND suppressed BETWEEN 0 AND 1125899906842623
    AND (suppressed = 0 OR kind = 'accepted')),
  created_at INTEGER NOT NULL,
  notify_after INTEGER NOT NULL,
  notify_failures INTEGER NOT NULL DEFAULT 0 CHECK (notify_failures >= 0),
  -- 1: an acceptance the mailbox could not record; it no longer holds up dispatch
  -- and waits for a notice or the reconciler (a later restore can let it apply).
  unapplied INTEGER NOT NULL DEFAULT 0 CHECK (unapplied IN (0, 1) AND (unapplied = 0 OR kind = 'accepted')),
  -- The mailbox's recovery epoch when the flag was set: a later epoch re-evaluates the row before any reclaim.
  unapplied_epoch INTEGER CHECK ((unapplied = 0 AND unapplied_epoch IS NULL)
    OR (unapplied = 1 AND typeof(unapplied_epoch) = 'integer' AND unapplied_epoch >= 0)),
  -- The epoch in which a flagged row had its one immediate recheck; after it, the row honors notify_after.
  rechecked_epoch INTEGER CHECK (rechecked_epoch IS NULL OR (typeof(rechecked_epoch) = 'integer' AND rechecked_epoch >= 0)),
  -- While an attempt holds a flagged row's recheck: until when. Separate from notify_after, which
  -- stays the reconciler's schedule; cleared when the attempt ends, or left to expire after a crash.
  recheck_lease_until INTEGER CHECK (recheck_lease_until IS NULL OR (typeof(recheck_lease_until) = 'integer' AND recheck_lease_until >= 0)),
  PRIMARY KEY (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt)
);
-- The reconciler's bounded page of rows whose notice is due.
CREATE INDEX send_results_notify ON send_results (notify_after, workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt);
-- One send's due rows that can apply, in order, and the earliest of them: the
-- drive row's and the claim's page and settled check.
CREATE INDEX send_results_send ON send_results (workspace_id, mailbox_id, send_id, notify_after, fence_epoch, fence_attempt) WHERE unapplied = 0;
-- One send's flagged acceptances, for their recheck after a restore and its settled check.
CREATE INDEX send_results_flagged ON send_results (workspace_id, mailbox_id, send_id, notify_after, unapplied_epoch, rechecked_epoch,
  fence_epoch, fence_attempt, recheck_lease_until) WHERE unapplied = 1;
