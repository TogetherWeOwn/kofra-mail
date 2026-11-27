export const JOURNAL_PAGE_SIZE = 64;

// The stored idempotency result committed in the same event as a send's effect.
export type JournalResult = { key: string; fingerprint: string; expiresAt: number; result: string };
export type SendAddress = { email: string; name?: string };
export type SendRecipient = SendAddress & { field: 'to' | 'cc' | 'bcc' };
export type SendRecipientKind = 'external' | 'internal';
export type SendFailure = 'invalid_sender' | 'message_too_large' | 'delivery_error';
// Everything the sent copy's bytes depend on, frozen at sendDraft
// (docs/m3-outbound-plan.md, section 2.3, step 2). The draft revision is
// immutable; boundary and Message-ID are derived once at submission.
export type SendRecord = {
  id: string; draftId: string; createdAt: number; undoUntil: number; dateAt: number; undoSeconds: number;
  boundary: string; messageId: string;
  ownerUserId: string; from: { email: string; name: string }; replyTo: [] | [SendAddress]; builderVersion: number;
  draft: { rawKey: string; holder: string; revision: string; updatedAt: number };
  attachmentKeys: string[]; uploadIds: string[]; recipients: SendRecipient[];
  // Each small forwarded part's decoded digest and size, fixed when it was attached.
  parts: SendPart[];
};
export type SendPart = { messageId: string; part: number; digest: string; size: number };
// The consumer's side of a send (docs/m3-outbound-plan.md, section 2.4; M3-5).
// A null lease means no lease is live; `graceReason` is the failure a grace
// hold ends in.
export type SendDispatchRow = {
  attempt: number; leaseEpoch: number | null; leaseAttempt: number | null; leaseUntil: number | null;
  nextAttemptAt: number; delayedUntil: number | null; ambiguous: number; providerWait: number; refusals: number;
  unfinished: number; heldAt: number | null; graceUntil: number | null; graceReason: SendFailure | null;
};
// A reported outcome under a fence; null until one is recorded.
export type SendFenceOutcome = 'accepted' | 'rejected' | 'try_later' | 'outage' | 'ambiguous' | 'delayed' | 'abandoned';
export type SendFenceRow = { epoch: number; attempt: number; leaseUntil: number; marked: boolean; authorized: boolean; outcome: SendFenceOutcome | null };
// One recipient of a fence's Mark set and its confirmed outcome under that fence.
export type SendMarkRow = { epoch: number; attempt: number; idx: number; outcome: 'sent' | 'suppressed' | 'failed' | null; providerId: string | null };
export type SendLedgerState = 'pending' | 'attempting' | 'sent' | 'failed' | 'suppressed';
export type SendLedgerChange = { idx: number; state: SendLedgerState; reason: string | null };
type SendProgressState = 'queued' | 'sending' | 'delayed' | 'sent' | 'partial' | 'failed';
// The sent copy's non-derived index state, as a message event carries it.
export type SentCopy = { id: string; rawKey: string; createdAt: number; threadId: string; dedupeKey: string;
  subjectKey: string; auth: string; attKeys: string[]; flags: number };

export type JournalEvent =
  // Non-derived message state only: parsed text never enters the journal.
  // subjectKey is a SHA-256 of the normalized subject, so threading survives a restore.
  | { type: 'message'; id: string; rawKey: string; createdAt: number; threadId: string; dedupeKey: string;
      subjectKey: string; auth: string; attKeys: string[] }
  | { type: 'receipt'; id: string }
  | { type: 'flags'; id: string; flags: number; labels: string[]; expiresAt?: number | null }
  | { type: 'label'; id: string; name: string }
  | { type: 'label_delete'; id: string }
  | { type: 'setting'; kind: 'filter' | 'send-as'; id: string; definition: string }
  | { type: 'api_settings'; definition: string }
  | { type: 'draft'; id: string; rawKey: string; holder: string; revision?: string; updatedAt?: number;
      uploadIds?: string[]; attachmentKeys?: string[] }
  | { type: 'draft_delete'; id: string; deferRelease?: true }
  | { type: 'api_upload'; id: string; objectKey: string; name: string; mediaType: string; size: number; expiresAt: number; holder?: string }
  | { type: 'api_upload_delete'; id: string; objectKey: string }
  | { type: 'api_source_lost'; kind: 'draft' | 'upload' | 'send'; id: string; holder: string }
  | { type: 'api_result'; key: string; fingerprint: string; expiresAt: number; result: string }
  | { type: 'api_result_expire'; key: string; expiresAt: number }
  | { type: 'bayes'; token: string; ham: number; spam: number }
  | { type: 'purge'; id: string }
  // The send state machine (M3-3). sendDraft: the pending send replaces the
  // draft, with the idempotency result, in one event.
  | { type: 'send_create'; send: SendRecord; result: JournalResult }
  // undoSend: cancelled, and the draft restored under its id with a new revision.
  | { type: 'send_undo'; id: string; revision: string; updatedAt: number; result: JournalResult }
  // Release step 1: pending to releasing.
  | { type: 'send_release'; id: string }
  // Release step 4: the sent copy's index row and one pending ledger row per recipient.
  | { type: 'send_queued'; id: string; message: SentCopy; kinds: SendRecipientKind[] }
  // A release-time failure (step 2): terminal, with one failed ledger row per recipient.
  | { type: 'send_fail'; id: string; reason: SendFailure; kinds: SendRecipientKind[] }
  // Finish rule step 4: cleanup is done.
  | { type: 'send_finish'; id: string }
  // The restore epilogue's fresh undo window for a restored pending send.
  | { type: 'send_window'; id: string; undoUntil: number }
  // A consumer step or a drive decision after release (M3-5): the send's state
  // (`terminal` starts the finish rule), its dispatch row, and the ledger rows,
  // fences, Mark sets and release-list entries it changed, all as absolute values.
  | { type: 'send_progress'; id: string; state: SendProgressState; terminal?: true; dispatch: SendDispatchRow;
      recipients?: SendLedgerChange[]; fences?: SendFenceRow[]; marks?: SendMarkRow[];
      releaseAdd?: { epoch: number; attempt: number }[]; releaseRemove?: { epoch: number; attempt: number }[] };

export type JournalRow = { seq: number; event: string };

export class MailJournal {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) { this.sql = sql; }

  revision(): number { return this.sql.exec<{ modseq: number }>('SELECT modseq FROM state WHERE id = 1').one().modseq; }
  flushed(): number { return this.sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed; }

  // Call inside the same transactionSync as the state write.
  append(event: JournalEvent): void { this.appendEncoded(this.revision() + 1, JSON.stringify(event)); }

  appendEncoded(seq: number, event: string): void {
    if (seq !== this.revision() + 1) throw new Error('Mailbox journal gap');
    this.sql.exec('INSERT INTO journal(seq, event) VALUES (?, ?)', seq, event);
    this.sql.exec('UPDATE state SET modseq = ? WHERE id = 1', seq);
  }

  // `through` cuts a page at a snapshot capture so no published delta spans it.
  page(after: number, through = Number.MAX_SAFE_INTEGER): JournalRow[] {
    return this.sql.exec<JournalRow>('SELECT seq, event FROM journal WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?',
      after, through, JOURNAL_PAGE_SIZE).toArray();
  }

  checkpoint(seq: number): void {
    this.sql.exec('UPDATE state SET flushed = max(flushed, ?) WHERE id = 1 AND modseq >= ?', seq, seq);
  }

  // The latest stored chain position at or before `seq`.
  chainedAtOrBefore(seq: number): { seq: number; chain: string } | null {
    return this.sql.exec<{ seq: number; chain: string }>(
      'SELECT seq, chain FROM journal WHERE seq <= ? AND chain IS NOT NULL ORDER BY seq DESC LIMIT 1', seq).toArray()[0] ?? null;
  }

  setChain(seq: number, chain: string): void {
    this.sql.exec('UPDATE journal SET chain = ? WHERE seq = ?', chain, seq);
  }

  event(seq: number): string | null {
    return this.sql.exec<{ event: string }>('SELECT event FROM journal WHERE seq = ?', seq).toArray()[0]?.event ?? null;
  }

  has(seq: number, event: string): boolean {
    return this.sql.exec('SELECT 1 FROM journal WHERE seq = ? AND event = ?', seq, event).toArray().length > 0;
  }
}
