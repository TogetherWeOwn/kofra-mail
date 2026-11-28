// FTS5's unicode61 tokenizer drops punctuation but indexes private-use tokens.
export const ATTACHMENT_SEARCH_BOUNDARY = String.fromCodePoint(0xE000);

// Local scheduling state of the mailbox object's one alarm (mailbox-timers.ts).
// Never journalled or copied into snapshots; rebuilt after a restore.
export const TIMERS_SCHEMA = `
-- claim: the token of the alarm call that claimed the row; every other write clears it.
-- requested: the earliest lower-only deadline asked for while the row was claimed
-- (later than its claimed fallback); it governs when the claim settles.
CREATE TABLE IF NOT EXISTS timers (due_at INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, claim TEXT, requested INTEGER,
  PRIMARY KEY (kind, ref));
CREATE INDEX IF NOT EXISTS timers_due ON timers(due_at, kind, ref);
`;

// The send state machine (docs/m3-outbound-plan.md, section 2; M3-3).
// mailbox_sends, its recipients (the ledger) and its upload references are
// non-derived state: every change is a journal event and they are in
// snapshots. `record` is the send's frozen input (section 2.3). The *_seq
// columns hold the journal seq of the event that set them, so whether a step
// is published is a comparison with the journal's flushed position.
// mailbox_send_drivers and mailbox_send_breaches are local scheduling state,
// cleared by a restore like the timer rows. `held` marks a pending send whose
// due drive row was held while the send path was off (section 2.5).
export const SEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_sends (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, undo_until INTEGER NOT NULL,
  holder TEXT NOT NULL, record TEXT NOT NULL, created_seq INTEGER NOT NULL, release_seq INTEGER, queued_seq INTEGER,
  terminal_seq INTEGER, message_id TEXT, reason TEXT, finish_pending INTEGER NOT NULL DEFAULT 0 CHECK (finish_pending IN (0, 1)),
  raw_key TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_send_page ON mailbox_sends(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mailbox_send_message ON mailbox_sends(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_send_holder ON mailbox_sends(holder);
CREATE TABLE IF NOT EXISTS mailbox_send_recipients (
  send_id TEXT NOT NULL REFERENCES mailbox_sends(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('external', 'internal')), state TEXT NOT NULL, reason TEXT, PRIMARY KEY (send_id, idx)
);
CREATE TABLE IF NOT EXISTS mailbox_send_uploads (
  send_id TEXT NOT NULL REFERENCES mailbox_sends(id) ON DELETE CASCADE, upload_id TEXT NOT NULL, PRIMARY KEY (send_id, upload_id)
);
CREATE INDEX IF NOT EXISTS mailbox_send_upload_refs ON mailbox_send_uploads(upload_id, send_id);
CREATE TABLE IF NOT EXISTS mailbox_send_drivers (
  send_id TEXT PRIMARY KEY, token TEXT NOT NULL, backoff INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1))
);
CREATE TABLE IF NOT EXISTS mailbox_send_breaches (send_id TEXT PRIMARY KEY, since INTEGER NOT NULL);
-- Local, like the drivers: the next retry of a send's internal handoff (M3-8),
-- which no move of the drive row passes while an internal recipient is pending,
-- and its stall clock's start (the send's release, from its journalled
-- undo_until), which no external activity or restore moves.
CREATE TABLE IF NOT EXISTS mailbox_send_handoffs (send_id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, since INTEGER NOT NULL);
-- The consumer's side of the state machine (section 2.4, M3-5), non-derived
-- like the ledger. mailbox_send_dispatch holds a send's attempt counter, its
-- live lease (fence = recovery epoch and attempt), the next attempt time, the
-- quota wait, the caps' counters and a grace hold. mailbox_send_fences is the
-- attempt history: one row per fence with its lease, whether Mark and an
-- authorization happened and its reported outcome; mailbox_send_marks is each
-- fence's Mark set with each recipient's confirmed outcome under it. A
-- recipient that is attempting is attempting under the newest marked fence
-- whose Mark set holds it. mailbox_send_release_list holds the fences whose
-- quota reservations must be released.
CREATE TABLE IF NOT EXISTS mailbox_send_dispatch (
  send_id TEXT PRIMARY KEY REFERENCES mailbox_sends(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
  lease_epoch INTEGER, lease_attempt INTEGER, lease_until INTEGER, next_attempt_at INTEGER NOT NULL, delayed_until INTEGER,
  ambiguous INTEGER NOT NULL, provider_wait INTEGER NOT NULL, refusals INTEGER NOT NULL, outages INTEGER NOT NULL, unfinished INTEGER NOT NULL,
  held_at INTEGER, grace_until INTEGER, grace_reason TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_send_held ON mailbox_send_dispatch(held_at) WHERE held_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS mailbox_send_fences (
  send_id TEXT NOT NULL REFERENCES mailbox_sends(id) ON DELETE CASCADE, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  lease_until INTEGER NOT NULL, marked INTEGER NOT NULL, authorized INTEGER NOT NULL, outcome TEXT,
  PRIMARY KEY (send_id, epoch, attempt)
);
CREATE TABLE IF NOT EXISTS mailbox_send_marks (
  send_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, idx INTEGER NOT NULL, outcome TEXT, provider_id TEXT,
  PRIMARY KEY (send_id, epoch, attempt, idx),
  FOREIGN KEY (send_id, epoch, attempt) REFERENCES mailbox_send_fences(send_id, epoch, attempt) ON DELETE CASCADE
);
-- Local, like the breaches: send_results rows that raise a mailbox alert, by code
-- ('unapplied': an acceptance that cannot be recorded; 'stuck': an applicable row that keeps failing).
CREATE TABLE IF NOT EXISTS mailbox_send_result_alerts (send_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  code TEXT NOT NULL CHECK (code IN ('unapplied', 'stuck')), since INTEGER NOT NULL, PRIMARY KEY (send_id, epoch, attempt, code));
CREATE TABLE IF NOT EXISTS mailbox_send_stalls (
  send_id TEXT PRIMARY KEY NOT NULL REFERENCES mailbox_sends(id) ON DELETE CASCADE,
  stall_since INTEGER NOT NULL, lease_expires_at INTEGER, expiries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mailbox_send_stalls_age ON mailbox_send_stalls(stall_since);
CREATE INDEX IF NOT EXISTS mailbox_send_stalls_expired ON mailbox_send_stalls(expiries) WHERE expiries >= 5;
-- Unsent one-shot operator events waiting for the directory alert outbox.
CREATE TABLE IF NOT EXISTS mailbox_send_event_outbox (
  day INTEGER NOT NULL, code TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY (day, code)
);
CREATE TABLE IF NOT EXISTS mailbox_send_release_list (
  send_id TEXT NOT NULL REFERENCES mailbox_sends(id) ON DELETE CASCADE, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  PRIMARY KEY (send_id, epoch, attempt)
);
`;

export const MAILBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, raw_key TEXT NOT NULL, size INTEGER NOT NULL,
  sent_date TEXT, sender TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL,
  subject TEXT NOT NULL, snippet TEXT NOT NULL, thread_id TEXT NOT NULL,
  flags INTEGER NOT NULL, internal_date INTEGER NOT NULL, gmail_id TEXT,
  message_id TEXT, dedupe_key TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'none',
  att_keys TEXT NOT NULL DEFAULT '[]',
  indexed INTEGER NOT NULL DEFAULT 1 CHECK (indexed IN (0, 1, 2)),
  folder_rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_by_header_id ON messages(message_id, internal_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, internal_date DESC);
CREATE INDEX IF NOT EXISTS messages_unindexed ON messages(id) WHERE indexed = 0;
CREATE INDEX IF NOT EXISTS mailbox_api_recent ON messages(internal_date DESC, thread_id DESC, id DESC) WHERE indexed = 1;
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS fingerprints (key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, subject_norm TEXT NOT NULL, last_date INTEGER NOT NULL, count INTEGER NOT NULL, assigned INTEGER NOT NULL,
  subject_key TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id), PRIMARY KEY (message_id, label_id)
);
CREATE INDEX IF NOT EXISTS messages_by_label ON message_labels(label_id, message_id);
CREATE TABLE IF NOT EXISTS attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part INTEGER NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL, object_key TEXT, PRIMARY KEY (message_id, part)
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, subject, addresses, body, attachment_names);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, raw_key TEXT NOT NULL, holder TEXT NOT NULL);
-- These columns extend M1's replayed rows without changing the meaning of legacy drafts/flags.
CREATE TABLE IF NOT EXISTS mailbox_api_drafts (
  id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE, revision TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_api_draft_page ON mailbox_api_drafts(updated_at DESC, id ASC);
CREATE TABLE IF NOT EXISTS mailbox_api_idempotency (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_api_idempotency_expiry ON mailbox_api_idempotency(expires_at, key);
CREATE TABLE IF NOT EXISTS mailbox_api_in_progress (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mailbox_api_progress_expiry ON mailbox_api_in_progress(expires_at, key);
CREATE TABLE IF NOT EXISTS mailbox_api_uploads (
  id TEXT PRIMARY KEY, object_key TEXT NOT NULL, name TEXT NOT NULL, media_type TEXT NOT NULL,
  size INTEGER NOT NULL, expires_at INTEGER NOT NULL, holder TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_api_upload_holder ON mailbox_api_uploads(holder);
CREATE INDEX IF NOT EXISTS mailbox_draft_holder ON drafts(holder);
CREATE TABLE IF NOT EXISTS mailbox_api_draft_uploads (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL REFERENCES mailbox_api_uploads(id), PRIMARY KEY (draft_id, upload_id)
);
CREATE INDEX IF NOT EXISTS mailbox_api_upload_refs ON mailbox_api_draft_uploads(upload_id, draft_id);
CREATE TABLE IF NOT EXISTS mailbox_api_draft_objects (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, object_key TEXT NOT NULL,
  PRIMARY KEY (draft_id, object_key)
);
CREATE TABLE IF NOT EXISTS mailbox_pending_releases (
  seq INTEGER NOT NULL, object_key TEXT NOT NULL, holder TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (seq, object_key, holder)
);
CREATE INDEX IF NOT EXISTS mailbox_release_retry ON mailbox_pending_releases(retry_at, seq, object_key, holder);
CREATE TABLE IF NOT EXISTS mailbox_pending_confirmations (
  seq INTEGER NOT NULL, object_key TEXT NOT NULL, holder TEXT NOT NULL, published_at INTEGER, lost_at INTEGER,
  PRIMARY KEY (seq, object_key, holder)
);
CREATE INDEX IF NOT EXISTS mailbox_confirm_published ON mailbox_pending_confirmations(published_at) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_confirm_unpublished ON mailbox_pending_confirmations(seq) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS mailbox_confirm_restore ON mailbox_pending_confirmations(seq, object_key, holder)
  WHERE published_at IS NOT NULL AND lost_at IS NULL;
CREATE TABLE IF NOT EXISTS mailbox_unusable_sources (
  kind TEXT NOT NULL, id TEXT NOT NULL, holder TEXT NOT NULL, PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS mailbox_alerts (code TEXT PRIMARY KEY, since INTEGER NOT NULL, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS mailbox_api_settings (id INTEGER PRIMARY KEY CHECK(id=1), definition TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mailbox_api_expiry (id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mailbox_api_expiry_time ON mailbox_api_expiry(expires_at, id);
-- Derived from the digest-verified raw MIME; never copied into snapshots or journal.
CREATE TABLE IF NOT EXISTS mailbox_api_display (
  id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, data TEXT NOT NULL, body_override TEXT
);
CREATE TABLE IF NOT EXISTS bayes (token TEXT PRIMARY KEY, ham INTEGER NOT NULL, spam INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (kind TEXT NOT NULL, id TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS backup_capture (row_no INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL);
-- chain: SHA-256 hash chain over every event through this seq, kept for published positions.
CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, event TEXT NOT NULL, chain TEXT);
CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), modseq INTEGER NOT NULL, flushed INTEGER NOT NULL);
INSERT OR IGNORE INTO state VALUES (1, 0, 0);
CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
${TIMERS_SCHEMA}
${SEND_SCHEMA}`;

// Columns added after the first mailboxes were written (M3-8). New and
// existing objects gain them by ALTER TABLE at the end of their tables, so both
// share one column order. `folder_rev` counts a message's folder changes (non-derived,
// journalled with the folder); `raw_key` is a released send's raw object.
const ADDED_COLUMNS = [
  ['messages', 'folder_rev', 'folder_rev INTEGER NOT NULL DEFAULT 0'],
  ['mailbox_sends', 'raw_key', 'raw_key TEXT'],
] as const;
const upgraded = new WeakSet<SqlStorage>();

export function upgradeMailboxSchema(sql: SqlStorage): void {
  if (upgraded.has(sql)) return;
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const present = sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().some(row => row.name === column);
    if (!present) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
  upgraded.add(sql);
}
