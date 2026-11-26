import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveContent, type ContentEnv } from '../src/entry.ts';

let clockOffset = 0;
let cacheReads = 0;
export default {
  async fetch(req: Request, env: ContentEnv) {
    const path = new URL(req.url).pathname;
    if (path === '/__clock') { clockOffset = Number(await req.text()); return new Response(null); }
    if (path === '/__cache') return Response.json(cacheReads);
    if (path === '/__epoch') {
      const [sub, ep] = await req.json<[string, number]>();
      epochs.set(sub, ep);
      return new Response(null);
    }
    if (path === '/__owner') { ownerA = await req.json(); return new Response(null); }
    if (path === '/__record') {
      const [key, value] = await req.json<[string, unknown]>();
      records.set(key, value);
      return new Response(null);
    }
    if (path === '/__mint') {
      const [method, ...args] = await req.json<[string, ...unknown[]]>();
      try { return Response.json({ value: await (env as ContentEnv & BridgeEnv).MINT[method](...args) }); }
      catch { return Response.json({ refused: true }); }
    }
    return serveContent(req, env, {
      now: () => Date.now() + clockOffset,
      imageCache: async () => {
        const cache = await caches.open('test-images');
        return { match: (key) => { cacheReads++; return cache.match(key); }, put: (key, res) => cache.put(key, res) };
      },
    });
  },
};
export { ContentMint } from '../src/entry.ts';

const epochs = new Map<string, number>();
export class CredentialEpoch extends WorkerEntrypoint {
  credentialEpoch(sub: string) { return sub.startsWith('user-') ? epochs.get(sub) ?? 1 : null; }
}

let ownerA: string | null = 'user-a';
const records = new Map<string, unknown>();
export class ContentLookup extends WorkerEntrypoint {
  mailboxOwner(ws: string, mb: string) {
    return ws === 'alpha' && mb === 'a' ? ownerA : ws === 'beta' && mb === 'b' ? 'user-b' : null;
  }
  messageRecord(ws: string, mb: string, sub: string, msg: string) {
    return this.mailboxOwner(ws, mb) === sub ? records.get(`${ws}/${mb}/${msg}`) ?? null : null;
  }
}
type BridgeEnv = { MINT: Record<string, (...args: unknown[]) => Promise<unknown>> };
