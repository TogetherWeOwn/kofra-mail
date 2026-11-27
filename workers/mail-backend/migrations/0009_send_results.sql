-- Provider results the send consumer could not record on the mailbox at once
-- (docs/m3-outbound-plan.md, section 2.4, step 6). Ids, recipient indexes and
-- provider message ids only: never addresses or content. A row is deleted only
-- after the mailbox recorded it and a publish covered it.
CREATE TABLE send_results (
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL CHECK (fence_epoch >= 0),
  fence_attempt INTEGER NOT NULL CHECK (fence_attempt >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('accepted', 'rejected', 'try_later', 'outage', 'ambiguous')),
  -- The provider's message id of an accepted call; null when it returned none.
  message_id TEXT CHECK (message_id IS NULL OR (kind = 'accepted' AND length(message_id) BETWEEN 1 AND 998)),
  -- A rejection's reason, or the error code of an outage or an ambiguous result.
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 64),
  -- The recipient indexes the provider reported suppressed, as a JSON array.
  suppressed TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suppressed) AND json_type(suppressed) = 'array'),
  created_at INTEGER NOT NULL,
  notify_after INTEGER NOT NULL,
  notify_failures INTEGER NOT NULL DEFAULT 0 CHECK (notify_failures >= 0),
  PRIMARY KEY (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt)
);
-- The reconciler's bounded page of rows whose notice is due.
CREATE INDEX send_results_notify ON send_results (notify_after, workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt);
