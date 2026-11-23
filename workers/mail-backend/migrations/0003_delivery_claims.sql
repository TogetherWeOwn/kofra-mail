ALTER TABLE deliveries ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1));
ALTER TABLE deliveries ADD COLUMN claim_owner TEXT;
ALTER TABLE deliveries ADD COLUMN alerted_at INTEGER;
CREATE INDEX deliveries_alert_due ON deliveries (state, alerted_at, id);
