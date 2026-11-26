import { WorkerEntrypoint } from 'cloudflare:workers';
import { ContentLookup } from '../../src/entry.ts';
import { Mailbox } from '../../src/mailbox-do.ts';
import { getThread } from '../../src/mailbox-api-messages.ts';
import { mailboxName } from '../../src/worker.ts';

export { ContentLookup };
export class LookupMailbox extends Mailbox {
  seed(state: string, alarm: number) {
    const { sql } = this.ctx.storage;
    sql.exec('INSERT INTO lifecycle VALUES (1, ?)', JSON.stringify({ state }));
    sql.exec(`INSERT INTO messages (id, raw_key, size, sender, recipients, cc, subject, snippet, thread_id, flags,
      internal_date, dedupe_key) VALUES ('m', 'raw-key', 10, '', '', '', '', '', 't', 131072, 1, 'dedupe')`);
    sql.exec(`INSERT INTO attachments VALUES ('m', 1, '', 'image/png', 3, NULL), ('m', 2, '', 'image/png', 3, 'att-key')`);
    sql.exec(`INSERT INTO mailbox_api_display VALUES ('m', '{"inline":[],"replyTo":[],"syntheticPart":2}', NULL)`);
    sql.exec(`INSERT INTO timers (due_at, kind, ref) VALUES (?, 'journal_flush', '')`, alarm);
    return this.ctx.storage.setAlarm(alarm);
  }

  expire() { this.ctx.storage.sql.exec("INSERT INTO mailbox_api_expiry VALUES ('m', 1)"); }
  async snapshot() {
    const { sql } = this.ctx.storage;
    return {
      schema: sql.exec('SELECT name, sql FROM sqlite_schema ORDER BY name').toArray(),
      storage: [...await this.ctx.storage.list()],
      lifecycle: sql.exec('SELECT * FROM lifecycle').toArray(),
      messages: sql.exec('SELECT * FROM messages').toArray(),
      attachments: sql.exec('SELECT * FROM attachments').toArray(),
      timers: sql.exec('SELECT * FROM timers').toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  verdict() { return getThread(this.ctx.storage.sql, 't', 2, 'test').messages[0].verdict.level; }
  evict() { this.ctx.abort('fixture eviction'); }
}

type ProbeEnv = { MAIL_LOOKUP: Record<string, (...args: unknown[]) => Promise<unknown>>; MAILBOX: DurableObjectNamespace<LookupMailbox> };
export default {
  async fetch(request: Request, env: ProbeEnv) {
    const [method, ...args]: [string, ...unknown[]] = await request.json();
    const box = () => env.MAILBOX.getByName(mailboxName('w', String(args[0])));
    switch (method) {
      case 'surface': return Response.json({
        names: Object.getOwnPropertyNames(ContentLookup.prototype).sort(),
        direct: Object.getPrototypeOf(ContentLookup.prototype) === WorkerEntrypoint.prototype,
      });
      case 'seed': await box().seed(String(args[1]), Number(args[2])); return Response.json(null);
      case 'snapshot': return Response.json(await box().snapshot());
      case 'verdict': return Response.json(await box().verdict());
      case 'expire': await box().expire(); return Response.json(null);
      case 'evict': try { await box().evict(); } catch { /* expected workerd eviction */ } return Response.json(null);
    }
    try { return Response.json({ value: await env.MAIL_LOOKUP[method](...args) }); }
    catch { return Response.json({ refused: true }); }
  },
};
