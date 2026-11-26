import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveContent, type ContentEnv } from '../src/entry.ts';
import { mimeBudgetUsage, reserveMime } from '../src/mime-budget.ts';
import { MAX_RAW_BYTES } from '../../mail-backend/src/bytes.ts';
import { remoteImageInFlight } from '../src/proxy.ts';

let clockOffset = 0;
let releaseHeldMime: (() => void) | undefined;
let cancelFlightLeader: (() => Promise<void>) | undefined;
export default {
  async fetch(req: Request, env: ContentEnv, ctx: ExecutionContext) {
    const path = new URL(req.url).pathname;
    if (path === '/__clock') { clockOffset = Number(await req.text()); return new Response(null); }
    if (path === '/__mime-budget') return Response.json(mimeBudgetUsage());
    if (path === '/__hold-mime') {
      releaseHeldMime = (await reserveMime(MAX_RAW_BYTES, req.signal))();
      return new Response(null);
    }
    if (path === '/__release-mime') {
      releaseHeldMime?.();
      releaseHeldMime = undefined;
      return new Response(null);
    }
    if (path === '/__image-budget') return Response.json(remoteImageInFlight());
    if (path === '/__cancel-flight-leader') {
      if (!cancelFlightLeader) return new Response(null, { status: 404 });
      await cancelFlightLeader();
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
    const io = { now: () => Date.now() + clockOffset };
    if (path === '/__unread-image') {
      const response = await serveContent(new Request(new URL(await req.text(), req.url)), env, io);
      const before = remoteImageInFlight();
      // Keep the invocation alive but leave the returned transfer unread.
      await new Promise(resolve => setTimeout(resolve, 60_100));
      const after = remoteImageInFlight();
      void response.body?.cancel().catch(() => {});
      return Response.json({ status: response.status, before, after });
    }
    if (req.headers.has('x-fixture-cancel-leader')) {
      const controller = new AbortController();
      const { promise, resolve } = Promise.withResolvers<void>();
      // Only resolve a JS promise from the control request. Abort in the
      // cancelled member's own Workerd invocation, not in the control request.
      const aborted = promise.then(() => controller.abort());
      const cancel = () => { resolve(); return aborted; };
      cancelFlightLeader = cancel;
      try {
        return await serveContent(new Request(req, { signal: AbortSignal.any([req.signal, controller.signal]) }), env, io, ctx);
      } finally { if (cancelFlightLeader === cancel) cancelFlightLeader = undefined; }
    }
    return serveContent(req, env, io, ctx);
  },
};
export { ContentMint } from '../src/entry.ts';

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
