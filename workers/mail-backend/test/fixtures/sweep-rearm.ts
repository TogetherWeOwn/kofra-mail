import { RETENTION_MS } from '../../src/reconcile.ts';
import { Sweeper } from '../../src/sweeper-do.ts';
import { SweepLedger } from '../../src/sweep-ledger.ts';
import type { Env } from '../../src/worker.ts';

export { MailAdmin } from '../../src/admin.ts';

type FixtureEnv = Env & {
  SWEEP_ADMIN: { rearmSweeper(workspaceId: string): Promise<void> };
  SWEEP_ALARM_COMPLETE: Fetcher;
};

export class SweepRearm extends Sweeper {
  private readonly switches: FixtureEnv;
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    const switches = { ...env };
    super(ctx, switches);
    this.switches = switches;
  }

  async enableSweeping() { this.switches.MAIL_SWEEP_ENABLED = 'on'; }
  async setBackendEnabled(value: 'on' | 'off') { this.switches.MAIL_BACKEND_ENABLED = value; }
  async alarmAt() { return this.ctx.storage.getAlarm(); }
  async nextSweep() { return new SweepLedger(this.ctx.storage).nextSweepAt(); }
  async legacyRelease(key: string) { new SweepLedger(this.ctx.storage).release(key, 'holder', Date.now()); }
  async rearmLedger() { await this.rearm(); }
  async evaluateWhileOff() { await super.alarm(); }

  override async alarm() {
    const mode = this.switches.MAIL_BACKEND_ENABLED;
    await super.alarm();
    await this.switches.SWEEP_ALARM_COMPLETE.fetch(`https://alarm.invalid/${mode}`);
  }

  async releaseWithOverdueGeneration(key: string) {
    // Read each armed time before an overdue workerd alarm can dispatch and rearm itself.
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.legacyRelease(key);
      const due = Date.now() - 60_000;
      this.ctx.storage.sql.exec('UPDATE generations SET last_ref_at = ? WHERE key = ?', due - RETENTION_MS, key);
      const started = Date.now();
      const alarms: Array<number | null> = [];
      for (const digit of ['c', 'd', 'e']) {
        const other = await this.register('raw', digit.repeat(64), 'holder');
        await this.release(other, 'holder');
        alarms.push(await this.alarmAt());
      }
      return JSON.stringify({ due, started, finished: Date.now(), alarms });
    });
  }

  // Fast-forward the test ledger and an existing alarm together, preserving
  // their relative due time. Never create a wake-up that release forgot to arm.
  async bringDueForward(key: string) {
    return this.bringAlarmForward(key);
  }

  // Brings a retired generation's second delete, and the alarm, forward.
  async bringSecondDeleteForward(key: string) {
    const due = Date.now() + 50;
    this.ctx.storage.sql.exec('UPDATE generations SET retry_at = ? WHERE key = ? AND retry_at IS NOT NULL', due, key);
    await this.ctx.storage.setAlarm(due);
  }

  async bringAlarmForward(key?: string) {
    if (await this.ctx.storage.getAlarm() === null) throw new Error('No sweep alarm to advance');
    const due = Date.now() + 50;
    if (key) this.ctx.storage.sql.exec('UPDATE generations SET last_ref_at = ? WHERE key = ?', due - RETENTION_MS, key);
    await this.ctx.storage.setAlarm(due);
    return due;
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv) {
    const [, route, workspaceId] = new URL(request.url).pathname.split('/');
    if (request.method !== 'POST' || route !== 'rearm') return new Response(null, { status: 404 });
    await env.SWEEP_ADMIN.rearmSweeper(workspaceId);
    return new Response(null, { status: 204 });
  },
};
