-- Provider results the send consumer could not record on the mailbox at once
-- (docs/m3-outbound-plan.md, section 2.4, step 6). Ids, recipient indexes and
-- provider message ids only: never addresses or content. A row is deleted only
-- after the mailbox recorded it and a publish covered it. The CHECKs match the
-- mailbox's own validation, so a row it would refuse is refused when written.
CREATE TABLE send_results (
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL CHECK (fence_epoch >= 0),
  fence_attempt INTEGER NOT NULL CHECK (fence_attempt >= 1),
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
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed BETWEEN 0 AND 1125899906842623 AND (suppressed = 0 OR kind = 'accepted')),
  created_at INTEGER NOT NULL,
  notify_after INTEGER NOT NULL,
  notify_failures INTEGER NOT NULL DEFAULT 0 CHECK (notify_failures >= 0),
  PRIMARY KEY (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt)
);
-- The reconciler's bounded page of rows whose notice is due.
CREATE INDEX send_results_notify ON send_results (notify_after, workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt);
