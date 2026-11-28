-- Internal delivery (docs/m3-outbound-plan.md, section 2.4, release step 6; M3-8).
-- One row per handoff of a send to recipients in its own workspace, keyed by
-- internal:<workspace>:<sending mailbox>:<sendId>. The first row written is the
-- decision; a later insert for the same key is ignored. The row carries the
-- internal recipient addresses (never their mailboxes, which are resolved when
-- the plan is written) as [ledger index, normalized local part, domain, address].
-- The key fits the supported maxima (workspace 58, mailbox 128, send 26: 223
-- characters) with headroom, up to 248 so its `handoff:` holder fits the
-- sweeper's 256-character holder bound.
CREATE TABLE internal_handoffs (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 248),
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  sender TEXT NOT NULL,
  addresses TEXT NOT NULL CHECK (json_valid(addresses) AND json_array_length(addresses) BETWEEN 1 AND 50),
  -- The sent copy's message id and its folder_rev as recorded at release (always 0).
  message_id TEXT NOT NULL,
  folder_rev INTEGER NOT NULL CHECK (folder_rev = 0),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reason TEXT CHECK ((decision = 'accepted' AND reason IS NULL)
    OR (decision = 'rejected' AND reason IN ('invalid_sender', 'link_expired'))),
  created_at INTEGER NOT NULL,
  -- The routing decision: written once, inside its own statement, from the directory.
  plan TEXT CHECK (plan IS NULL OR (decision = 'accepted' AND json_valid(plan))),
  -- The reconciler's retry of an accepted handoff the drive handler could not expand.
  expand_retry_at INTEGER CHECK ((expand_retry_at IS NULL) = (decision = 'rejected')),
  expand_attempts INTEGER NOT NULL DEFAULT 0 CHECK (expand_attempts >= 0),
  expanded_at INTEGER CHECK (expanded_at IS NULL OR plan IS NOT NULL),
  -- Set with the child rows; cleared once the handoff holder is released.
  holder_release_pending INTEGER NOT NULL DEFAULT 0 CHECK (holder_release_pending IN (0, 1)
    AND (holder_release_pending = 0 OR expanded_at IS NOT NULL)),
  release_retry_at INTEGER CHECK ((release_retry_at IS NULL) = (holder_release_pending = 0)),
  release_attempts INTEGER NOT NULL DEFAULT 0 CHECK (release_attempts >= 0),
  -- The sender's acknowledgement mark (finish rule step 3).
  acknowledged_at INTEGER,
  -- When the row may be deleted: 7 days after both its expansion (none for a
  -- rejected row) and the acknowledgement mark, and never while a release is pending.
  prune_after INTEGER CHECK (prune_after IS NULL OR (acknowledged_at IS NOT NULL AND holder_release_pending = 0
    AND (decision = 'rejected' OR expanded_at IS NOT NULL)))
);
CREATE INDEX internal_handoffs_expand ON internal_handoffs (expand_retry_at, key) WHERE decision = 'accepted' AND expanded_at IS NULL;
CREATE INDEX internal_handoffs_release ON internal_handoffs (release_retry_at, key) WHERE holder_release_pending = 1;
CREATE INDEX internal_handoffs_prune ON internal_handoffs (prune_after, key) WHERE prune_after IS NOT NULL;
-- Who wrote a delivery: the inbound path ('inbound') or a handoff's expansion
-- ('internal'). Only the expansion writes 'internal'; the mailbox trusts an
-- internal sender only from this column, never from a header.
ALTER TABLE deliveries ADD COLUMN source TEXT NOT NULL DEFAULT 'inbound' CHECK (source IN ('inbound', 'internal'));
-- 'file_sent': instead of a second copy, file the sender's existing sent copy
-- (file_message_id) into Inbox if its folder_rev still equals file_folder_rev.
ALTER TABLE deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'deliver' CHECK (kind IN ('deliver', 'file_sent'));
ALTER TABLE deliveries ADD COLUMN file_message_id TEXT;
ALTER TABLE deliveries ADD COLUMN file_folder_rev INTEGER CHECK (
  ((kind = 'file_sent') = (file_message_id IS NOT NULL)) AND ((kind = 'file_sent') = (file_folder_rev IS NOT NULL))
  AND (kind = 'deliver' OR source = 'internal'));
