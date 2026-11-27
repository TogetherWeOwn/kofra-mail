import { createHash } from 'node:crypto';

// Node has no DigestStream; the Workers runtime provides it. Tests that run
// the parser's store path in Node install this SHA-256-only stand-in.
class NodeDigestStream extends WritableStream<ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    if (algorithm !== 'SHA-256') throw new Error(`Unsupported digest ${algorithm}`);
    const hash = createHash('sha256');
    let done!: (value: ArrayBuffer) => void;
    let fail!: (reason: unknown) => void;
    super({
      write(chunk) { hash.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); },
      close() { done(new Uint8Array(hash.digest()).buffer); },
      // As in the Workers runtime, an aborted stream rejects its digest.
      abort(reason) { fail(reason); },
    });
    this.digest = new Promise((resolve, reject) => { done = resolve; fail = reject; });
  }
}

export function installDigestStream(): void {
  if (!('DigestStream' in crypto)) Object.assign(crypto, { DigestStream: NodeDigestStream });
}
