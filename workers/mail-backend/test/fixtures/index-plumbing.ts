import { MailboxIndex, PermanentMailError } from '../../src/mailbox-index.ts';
import { FixtureMailbox } from './mailbox-worker.ts';

export class IndexPlumbing extends FixtureMailbox {
  async indexRaw(id: string, key: string, results: string | null = null) {
    const index = new MailboxIndex(this.ctx.storage, {
      get: async rawKey => {
        const object = await this.env.RAW.get(rawKey);
        if (!object) throw new Error('Missing fixture raw object');
        return new Uint8Array(await object.arrayBuffer());
      },
      put: async (objectKey, bytes) => { await this.env.RAW.put(objectKey, bytes); },
      register: async (kind, digest) => `${kind}/${digest}/01KBN8ZJ7G0000000000000000`,
      hold: async () => {}, release: async () => {},
    }, this.ctx.id.toString());
    try { await index.ingest(id, key, 100, results); }
    catch (error) {
      if (error instanceof PermanentMailError) return error.message;
      throw error;
    }
    return 'indexed';
  }

  async journalEvents() {
    const rows = this.ctx.storage.sql.exec<{ event: string }>('SELECT event FROM journal ORDER BY seq').toArray();
    return JSON.stringify(rows.map(row => JSON.parse(row.event)));
  }

  async parts() {
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT * FROM attachments ORDER BY part').toArray());
  }
}

export default {};
