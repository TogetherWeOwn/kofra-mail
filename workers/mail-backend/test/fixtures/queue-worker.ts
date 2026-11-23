import { handleEmail, handleQueue, type Env } from '../../src/worker.ts';
import { Mailbox, Sweeper } from '../../src/entry.ts';
import { SweepLedger } from '../../src/sweep-ledger.ts';

export class QueueFixtureSweeper extends Sweeper {
  async alarmTime() { return this.ctx.storage.getAlarm(); }
  async seedExpired(digest: string) {
    const ledger = new SweepLedger(this.ctx.storage);
    const key = ledger.register('raw', digest, 'fixture', 100);
    ledger.release(key, 'fixture', 100);
    return key;
  }
  async runArmedAlarmSoon() {
    if (await this.ctx.storage.getAlarm() === null) throw new Error('No sweeper alarm armed');
    await this.ctx.storage.setAlarm(Date.now());
  }
  override async alarm() {
    await super.alarm();
    await (this.env as FixtureEnv).NOTIFY.fetch('https://completion.example.test/sweep', { method: 'POST' });
  }
}

interface FixtureEnv extends Env { NOTIFY: Fetcher; }

export class QueueFixtureMailbox extends Mailbox {
  async alarmTime() { return this.ctx.storage.getAlarm(); }
  async runArmedAlarmSoon() {
    if (await this.ctx.storage.getAlarm() === null) throw new Error('Delivery did not arm a journal alarm');
    await this.ctx.storage.setAlarm(Date.now());
  }
  override async alarm() {
    await super.alarm();
    await (this.env as FixtureEnv).NOTIFY.fetch('https://completion.example.test/alarm', { method: 'POST' });
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    if (!request.body) return new Response(null, { status: 400 });
    let reject = false;
    await handleEmail({
      from: 'sender@example.test', to: 'reader@example.test', raw: request.body,
      rawSize: Number(request.headers.get('content-length')),
      setReject() { reject = true; },
    }, env);
    return new Response(null, { status: reject ? 422 : 202 });
  },
  async queue(batch: MessageBatch<unknown>, env: FixtureEnv) {
    const message = batch.messages[0];
    if (!message || typeof message.body !== 'string') throw new Error('Expected a queued delivery ID');
    const id = message.body;
    const notify = (path: string) => env.NOTIFY.fetch(`https://completion.example.test${path}`, {
      method: 'POST', body: JSON.stringify({ id, queueId: message.id, attempts: message.attempts }),
    });
    const control = await notify('/before-queue');
    if (control.status === 202) {
      // Seed the row before workerd starts the fault-injected queue invocation.
      await env.DIRECTORY.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(id).run();
      const directory = env.DIRECTORY;
      const prepare = (sql: string) => {
        if (sql.startsWith("UPDATE deliveries SET state = 'done'")) throw new Error('D1 completion unavailable');
        return directory.prepare(sql);
      };
      await handleQueue(batch, { ...env, DIRECTORY: new Proxy(directory, {
        get(target, key) {
          if (key === 'prepare') return prepare;
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) });
    } else {
      await handleQueue(batch, env);
    }
    await notify('/after-queue');
  },
};
