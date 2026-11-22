CREATE TABLE domains (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58 AND workspace_id NOT GLOB '*[^a-z0-9-]*' AND workspace_id NOT GLOB '*-'
    AND workspace_id NOT GLOB '*--*' AND workspace_id NOT GLOB '*-s3alias'),
  name TEXT NOT NULL UNIQUE CHECK (name = lower(name)),
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'secondary', 'alias')),
  alias_of TEXT,
  routing_state TEXT NOT NULL,
  sending_state TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, alias_of) REFERENCES domains (workspace_id, id),
  CHECK ((kind = 'alias' AND alias_of IS NOT NULL AND alias_of <> id)
         OR (kind <> 'alias' AND alias_of IS NULL))
);

CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58 AND workspace_id NOT GLOB '*[^a-z0-9-]*' AND workspace_id NOT GLOB '*-'
    AND workspace_id NOT GLOB '*--*' AND workspace_id NOT GLOB '*-s3alias'),
  user_id TEXT NOT NULL,
  primary_address TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id),
  UNIQUE (primary_address)
);

CREATE TABLE addresses (
  -- SQLite lower() folds ASCII only; JavaScript folds the rest at lookup.
  address_norm TEXT PRIMARY KEY NOT NULL CHECK (address_norm = lower(address_norm)),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58 AND workspace_id NOT GLOB '*[^a-z0-9-]*' AND workspace_id NOT GLOB '*-'
    AND workspace_id NOT GLOB '*--*' AND workspace_id NOT GLOB '*-s3alias'),
  target_kind TEXT NOT NULL CHECK (target_kind = 'mailbox'),
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  send_as_policy TEXT NOT NULL,
  FOREIGN KEY (workspace_id, target_id) REFERENCES mailboxes (workspace_id, id)
);

CREATE INDEX domains_by_alias ON domains (workspace_id, alias_of);
CREATE INDEX addresses_by_mailbox ON addresses (workspace_id, target_id);

CREATE TRIGGER domains_direct_alias_insert BEFORE INSERT ON domains
WHEN NEW.kind = 'alias' AND (
  NOT EXISTS (SELECT 1 FROM domains WHERE workspace_id = NEW.workspace_id AND id = NEW.alias_of AND kind <> 'alias')
  OR EXISTS (SELECT 1 FROM domains WHERE workspace_id = NEW.workspace_id AND alias_of = NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'Alias must point to a canonical domain');
END;

CREATE TRIGGER domains_direct_alias_update BEFORE UPDATE ON domains
WHEN NEW.kind = 'alias' AND (
  NOT EXISTS (SELECT 1 FROM domains WHERE workspace_id = NEW.workspace_id AND id = NEW.alias_of AND kind <> 'alias')
  OR EXISTS (SELECT 1 FROM domains WHERE workspace_id = NEW.workspace_id AND alias_of = NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'Alias must point to a canonical domain');
END;
