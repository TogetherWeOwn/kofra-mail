import { kofra, type KofraConfig } from '../../src/kofra.ts';
import { MailboxIndex, PermanentMailError } from '../../src/mailbox-index.ts';
import { FixtureMailbox, fixturePutStream } from './mailbox-worker.ts';
export { FixtureSweeper } from './mailbox-worker.ts';

export class IndexPlumbing extends FixtureMailbox {
  async indexRaw(id: string, key: string, results: string | null = null) {
    const index = new MailboxIndex(this.ctx.storage, {
      get: async rawKey => {
        const object = await this.env.RAW.get(rawKey);
        if (!object) throw new Error('Missing fixture raw object');
        return new Uint8Array(await object.arrayBuffer());
      },
      put: async (objectKey, bytes) => { await this.env.RAW.put(objectKey, bytes); },
      putStream: fixturePutStream(this.env.RAW),
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

  // How the last indexThroughKofra stored each object: the method, and for a
  // streamed PUT the number of chunks and the largest one.
  private calls: Array<{ method: string; key: string; chunks?: number; largest?: number }> = [];
  async storeCalls() { return JSON.stringify(this.calls); }

  // The production object store for attachments: the Kofra S3 adapter.
  async indexThroughKofra(id: string, key: string) {
    const store = kofra(this.env as unknown as KofraConfig, 'workspace');
    const calls: typeof this.calls = this.calls = [];
    const index = new MailboxIndex(this.ctx.storage, {
      ...store,
      put: (objectKey, bytes) => { calls.push({ method: 'put', key: objectKey }); return store.put(objectKey, bytes); },
      putStream: (objectKey, content, size, digest) => {
        const call = { method: 'putStream', key: objectKey, chunks: 0, largest: 0 };
        calls.push(call);
        const counted = content.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          call.chunks++;
          call.largest = Math.max(call.largest, chunk.byteLength);
          controller.enqueue(chunk);
        } }));
        return store.putStream(objectKey, counted, size, digest);
      },
      get: async rawKey => {
        const object = await this.env.RAW.get(rawKey);
        if (!object) throw new Error('Missing fixture raw object');
        return new Uint8Array(await object.arrayBuffer());
      },
      register: async (kind, digest) => `${kind}/${digest}/01KBN8ZJ7G0000000000000000`,
      hold: async () => {}, release: async () => {},
    }, this.ctx.id.toString());
    try { await index.ingest(id, key, 100); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
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
