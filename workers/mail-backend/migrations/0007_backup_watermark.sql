-- Set once a mailbox has a backup baseline. With the manifest missing, it means
-- the backups were lost, not that the mailbox is new.
ALTER TABLE mailboxes ADD COLUMN backup_initialized INTEGER NOT NULL DEFAULT 0 CHECK (backup_initialized IN (0, 1));
-- Informational: the latest delivery cursor a published backup of this mailbox
-- was confirmed to cover (0 while restoring or after backup loss). Pruning uses
-- the mailbox's own verified cursor in the same run, not this column.
ALTER TABLE mailboxes ADD COLUMN backup_done_at INTEGER NOT NULL DEFAULT 0 CHECK (backup_done_at >= 0);
-- Incremented by each operator re-drive; part of the identity of a delivery's
-- failed and stuck alerts, so every occurrence gets its own obligation.
ALTER TABLE deliveries ADD COLUMN redrives INTEGER NOT NULL DEFAULT 0 CHECK (redrives >= 0);
