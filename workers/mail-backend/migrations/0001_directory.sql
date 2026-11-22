CREATE TABLE domains (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
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
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  primary_address TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id),
  UNIQUE (primary_address)
);

CREATE TABLE addresses (
  address_norm TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind = 'mailbox'),
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  send_as_policy TEXT NOT NULL,
  FOREIGN KEY (workspace_id, target_id) REFERENCES mailboxes (workspace_id, id)
);

CREATE INDEX domains_by_alias ON domains (workspace_id, alias_of);
CREATE INDEX addresses_by_mailbox ON addresses (workspace_id, target_id);
