import { WorkerEntrypoint } from 'cloudflare:workers';

type AccountEnv = { USERS: string[]; CONTROL?: string };
const epochs = new Map<string, number>();

/** The account Worker does not exist yet. This fake's named binding is read-only. */
export class CredentialEpoch extends WorkerEntrypoint<AccountEnv> {
  credentialEpoch(sub: string) {
    return this.env.USERS.includes(sub) ? epochs.get(sub) ?? 1 : null;
  }
}

export default {
  async fetch(request: Request, env: AccountEnv) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/__epoch' ||
        !env.CONTROL || request.headers.get('x-fixture-control') !== env.CONTROL) return new Response(null, { status: 404 });
    const [sub, ep] = await request.json<[string, number]>();
    epochs.set(sub, ep);
    return new Response(null, { status: 204 });
  },
};
