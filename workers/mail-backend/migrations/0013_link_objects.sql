-- M3-13 routing rows without an upload id are retained for earlier journals.
ALTER TABLE file_links ADD COLUMN upload_id TEXT;
CREATE INDEX file_links_legacy_location ON file_links(workspace_id, location_id)
  WHERE location_kind = 'workspace' AND upload_id IS NULL;

-- Provider effects are registered here before any write and are never rewound by a mailbox restore.
CREATE TABLE link_objects (
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  id TEXT NOT NULL,
  location_kind TEXT NOT NULL CHECK (location_kind IN ('deployment', 'workspace')),
  location_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5368709120),
  parts INTEGER NOT NULL CHECK (parts BETWEEN 1 AND 320),
  state TEXT NOT NULL CHECK (state IN ('opening', 'uploading', 'complete', 'deleting', 'retiring', 'deleted')),
  abandoned INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1)),
  provider_upload TEXT,
  version_id TEXT,
  idem_key TEXT,
  request_fingerprint TEXT NOT NULL,
  idem_expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  day INTEGER NOT NULL,
  sweep_at INTEGER,
  wake_rev INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  confirm_since INTEGER,
  delete_since INTEGER,
  alert_at INTEGER,
  lease TEXT,
  lease_until INTEGER,
  PRIMARY KEY (workspace_id, mailbox_id, id)
);
CREATE UNIQUE INDEX link_objects_idempotency ON link_objects(workspace_id, mailbox_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE UNIQUE INDEX link_objects_key ON link_objects(workspace_id, mailbox_id, object_key);
CREATE INDEX link_objects_sweep ON link_objects(sweep_at) WHERE sweep_at IS NOT NULL;
CREATE INDEX link_objects_location ON link_objects(workspace_id, location_id) WHERE location_kind = 'workspace' AND state <> 'deleted';
CREATE TABLE link_live_bytes (workspace_id TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK (size >= 0));
CREATE TABLE link_daily_bytes (workspace_id TEXT NOT NULL, day INTEGER NOT NULL, size INTEGER NOT NULL CHECK (size >= 0), PRIMARY KEY (workspace_id, day));
CREATE INDEX link_daily_bytes_day ON link_daily_bytes(day);

-- Atomic with the guarded registry insert. Live reservations are released only after
-- the provider object and any multipart sessions are gone. Daily usage never refunds.
CREATE TRIGGER link_object_reserve AFTER INSERT ON link_objects BEGIN
  INSERT INTO link_live_bytes VALUES (NEW.workspace_id, NEW.size)
    ON CONFLICT(workspace_id) DO UPDATE SET size = size + NEW.size;
  INSERT INTO link_daily_bytes VALUES (NEW.workspace_id, NEW.day, NEW.size)
    ON CONFLICT(workspace_id, day) DO UPDATE SET size = size + NEW.size;
END;
CREATE TRIGGER link_object_release AFTER UPDATE OF state ON link_objects
  WHEN NEW.state = 'deleted' AND OLD.state <> 'deleted' BEGIN
  UPDATE link_live_bytes SET size = size - OLD.size WHERE workspace_id = OLD.workspace_id;
END;
