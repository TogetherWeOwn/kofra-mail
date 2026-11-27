import { kofra, type KofraConfig } from '../../src/kofra.ts';
import { MailboxIndex, PermanentMailError } from '../../src/mailbox-index.ts';
import { boundedMime, partDigest, partStream } from '../../src/parse-mail.ts';
import { FixtureMailbox, fixturePutStream } from './mailbox-worker.ts';

// Unhandled rejections seen by this isolate, for the streamed-PUT failure test.
const unhandled: string[] = [];
globalThis.addEventListener('unhandledrejection', event => {
  unhandled.push(String(event.reason));
  event.preventDefault();
});
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

  // Streams a stored message's first measured part through the Kofra adapter
  // so that the body fails: 'overlong' claims a size the replay overruns, so it
  // fails before any byte; 'digest' claims another digest, so every block but
  // the last is sent first. Reports what the caller saw and any unhandled
  // rejection that followed.
  async overlongThroughKofra(rawKey: string, mode: 'overlong' | 'digest' = 'overlong') {
    const object = await this.env.RAW.get(rawKey);
    if (!object) throw new Error('Missing fixture raw object');
    const { contents } = await boundedMime(new Uint8Array(await object.arrayBuffer()));
    const source = contents.find(content => !(content instanceof Uint8Array));
    if (!source || source instanceof Uint8Array) throw new Error('No measured part');
    const digest = 'a'.repeat(64);
    const short = mode === 'overlong' ? { ...source, size: 64 * 1024 } : source;
    unhandled.length = 0;
    let error = 'stored';
    try { await kofra(this.env as unknown as KofraConfig, 'workspace').putStream(`att/${digest}/01KBN8ZJ7G0000000000000000`, partStream(short, digest), short.size, digest); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    await new Promise(resolve => setTimeout(resolve, 200));
    return JSON.stringify({ error, unhandled });
  }

  // The digest pass of a stored message's first measured part with a measured
  // size one byte short of the replay, in the Workers runtime's DigestStream:
  // reports the rejection and any unhandled rejection that followed.
  async shortDigest(rawKey: string) {
    const object = await this.env.RAW.get(rawKey);
    if (!object) throw new Error('Missing fixture raw object');
    const { contents } = await boundedMime(new Uint8Array(await object.arrayBuffer()));
    const source = contents.find(content => !(content instanceof Uint8Array));
    if (!source || source instanceof Uint8Array) throw new Error('No measured part');
    unhandled.length = 0;
    let error = 'digested';
    try { await partDigest({ ...source, size: source.size - 1 }); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    await new Promise(resolve => setTimeout(resolve, 200));
    return JSON.stringify({ error, unhandled });
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
