-- A restore bumps the mailbox's recovery epoch before replaying; a delivery
-- claimed under an older epoch can no longer be marked done.
ALTER TABLE mailboxes ADD COLUMN recovery_epoch INTEGER NOT NULL DEFAULT 0 CHECK (recovery_epoch >= 0);
-- `lease` fences claims and reservations. `attempts` now counts only processing
-- failures of the stored message; `retries` drives backoff for everything else.
ALTER TABLE deliveries ADD COLUMN lease INTEGER NOT NULL DEFAULT 0 CHECK (lease >= 0);
ALTER TABLE deliveries ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 30);
ALTER TABLE deliveries ADD COLUMN claim_epoch INTEGER;
-- Before this migration `attempts` counted claims, not rejected processing; a
-- pending row starts with a full rejection budget under the new meaning.
UPDATE deliveries SET attempts = 0 WHERE state = 'pending';
