-- Additional directory state for the local-only mail API. No inbound routing change.
CREATE TABLE mailbox_profiles (
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (workspace_id, mailbox_id),
  FOREIGN KEY (workspace_id, mailbox_id) REFERENCES mailboxes (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE directory_api_keys (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE INDEX directory_mailboxes_address ON mailboxes (workspace_id, primary_address, id);
CREATE INDEX directory_domains_name ON domains (workspace_id, name);

-- Protect the alias cap when distinct keys race between the read and D1 batch.
CREATE TRIGGER directory_alias_limit BEFORE INSERT ON addresses
WHEN NEW.kind = 'alias' AND (
  SELECT count(*) FROM addresses
  WHERE workspace_id = NEW.workspace_id AND target_id = NEW.target_id AND kind = 'alias'
) >= 30
BEGIN
  SELECT RAISE(ABORT, 'Mailbox alias limit reached');
END;
