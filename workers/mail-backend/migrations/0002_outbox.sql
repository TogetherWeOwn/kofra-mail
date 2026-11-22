CREATE TABLE deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58 AND workspace_id NOT GLOB '*[^a-z0-9-]*' AND workspace_id NOT GLOB '*-'
    AND workspace_id NOT GLOB '*--*' AND workspace_id NOT GLOB '*-s3alias' AND instr(workspace_id, char(0)) = 0),
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  resolved_mailbox_ids TEXT NOT NULL CHECK (json_valid(resolved_mailbox_ids) AND json_array_length(resolved_mailbox_ids) = 1),
  group_post_ids TEXT NOT NULL CHECK (group_post_ids = '[]'),
  raw_key TEXT NOT NULL,
  auth_results TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  CHECK ((state = 'done') = (done_at IS NOT NULL))
);

CREATE INDEX deliveries_due ON deliveries (state, next_attempt_at, id);
CREATE INDEX deliveries_by_state_created ON deliveries (state, created_at, id);
CREATE INDEX deliveries_done_at ON deliveries (state, done_at, id);
