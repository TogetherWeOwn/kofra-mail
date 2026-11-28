-- Revocable file links (docs/m3-outbound-plan.md, M3-13).
-- The routing table: SHA-256 of each link's 128-bit token (hex) to the sender's
-- workspace, mailbox and link id. Release step 4b inserts one row per link with
-- INSERT OR IGNORE once the release is published. The token itself is never
-- stored here, and whether a link is live always comes from the mailbox.
-- `location_kind` and `location_id` name where the link's object lives, so a
-- workspace location can answer whether anything still uses it (M3-15a); a
-- row for a workspace location is inserted only while that location is
-- `active`, in the same statement. `reports` counts abuse reports, at most 10.
CREATE TABLE file_links (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND NOT token_hash GLOB '*[^0-9a-f]*'),
  link_id TEXT NOT NULL CHECK (length(link_id) = 26 AND NOT link_id GLOB '*[^a-z2-7]*'),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58),
  mailbox_id TEXT NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 128),
  location_kind TEXT NOT NULL CHECK (location_kind IN ('deployment', 'workspace')),
  location_id TEXT NOT NULL CHECK (length(location_id) BETWEEN 1 AND 32),
  created_at INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0 CHECK (reports BETWEEN 0 AND 10)
);
-- The operator's revoke by link id.
CREATE UNIQUE INDEX file_links_by_id ON file_links (link_id);
-- The location delete's usage check: one indexed point lookup per location.
CREATE INDEX file_links_by_location ON file_links (workspace_id, location_kind, location_id);
