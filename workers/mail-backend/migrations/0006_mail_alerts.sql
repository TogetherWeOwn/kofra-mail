CREATE TABLE mail_alerts (
  key TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX mail_alerts_unsent ON mail_alerts (created_at, key) WHERE sent_at IS NULL;
CREATE INDEX mail_alerts_sent ON mail_alerts (sent_at, key) WHERE sent_at IS NOT NULL;
