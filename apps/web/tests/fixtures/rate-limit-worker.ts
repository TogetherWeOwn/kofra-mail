import { handleMailApi, type MailApiEnvironment } from '../../src/lib/server/mail-api.ts';

export default {
  async fetch(request: Request, bindings: MailApiEnvironment) {
    const { method, path, limit, admitted, distinct = false, actor } = await request.json() as {
      method: string; path: string; limit: number; admitted: number; distinct?: boolean; actor: string;
    };
    const origin = 'http://127.0.0.1';
    const env: MailApiEnvironment = {
      ...bindings, MAIL_LOCAL_API: 'on', MAIL_DRAFT_UPLOADS_ENABLED: 'on', MAIL_SEND_ENABLED: 'on',
      MAIL_DEV_SESSION: { resolve: async () => ({ userId: actor, name: 'Member', workspaceId: actor, role: 'admin',
        authTime: Date.now(), credentialEpoch: 1, csrfToken: 'fixture-csrf' }) },
      DIRECTORY: { prepare: () => ({ bind() { return this; }, async first<T>() { return { id: actor } as T; },
        async all<T>() { return { results: [] as T[] }; } }), async batch() { return []; } },
      MAILBOX: { getByName: () => ({ async mailApi(_ws, _mb, op) {
        return op === 'undoSend' ? { error: { code: 'not_found' } } : { body: { state: 'ready' } };
      } }) },
    };
    // Keep the batch within one worker; return the first deviation or the request just over the limit.
    for (let i = 0; i <= limit; i++) {
      const headers = { origin, 'x-csrf-token': 'fixture-csrf', ...(distinct && { 'idempotency-key': `undo-${i}` }) };
      const url = `${origin}/api/v1${path.replace('{id}', distinct ? String(i) : 'one')}`;
      const reply = await handleMailApi(new Request(url, { method, headers }), env);
      if (i === limit || reply.status !== admitted) return Response.json({ index: i, status: reply.status,
        retryAfter: reply.headers.get('retry-after'), body: await reply.json() });
    }
    throw new Error('no limiter result');
  },
};
