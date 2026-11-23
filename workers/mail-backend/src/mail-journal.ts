export const JOURNAL_PAGE_SIZE = 64;

export type JournalEvent =
  // Non-derived message state only: parsed text never enters the journal.
  // subjectKey is a SHA-256 of the normalized subject, so threading survives a restore.
  | { type: 'message'; id: string; rawKey: string; createdAt: number; threadId: string; dedupeKey: string;
      subjectKey: string; auth: string; attKeys: string[] }
  | { type: 'receipt'; id: string }
  | { type: 'flags'; id: string; flags: number; labels: string[] }
  | { type: 'label'; id: string; name: string }
  | { type: 'setting'; kind: 'filter' | 'send-as'; id: string; definition: string }
  | { type: 'draft'; id: string; rawKey: string; holder: string }
  | { type: 'bayes'; token: string; ham: number; spam: number }
  | { type: 'purge'; id: string };

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
