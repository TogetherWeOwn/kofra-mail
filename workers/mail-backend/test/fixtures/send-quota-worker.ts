import { SendQuota, type SendQuotaConfig } from '../../src/send-quota.ts';
import type { QuotaPort } from '../../src/mailbox-send-quota.ts';

export type QuotaFixtureEnv = SendQuotaConfig & { INITIAL_TIME: number; AUTO_ALERT_ALARM?: boolean };

export function quotaFixture<Env extends QuotaFixtureEnv>(clock: (env: Env) => number) {
  return class FixtureSendQuota extends SendQuota {
    private clockOverride?: number;
    private failures = new Map<string, number>();
    constructor(ctx: DurableObjectState, private readonly fixtureEnv: Env) { super(ctx, fixtureEnv); }
    protected override now() { return this.clockOverride ?? clock(this.fixtureEnv); }
    setTime(now: number) { this.clockOverride = now; }
    private alarmAt: number | null = null;
    protected override async armAlert(at: number) {
      this.alarmAt = at;
      // Keep the actual storage alarm in the wake-up test, with short wall-clock
      // intervals so the separate simulated quota clock can stay deterministic.
      if (this.fixtureEnv.AUTO_ALERT_ALARM) await super.armAlert(Date.now() + 250);
    }
    alarmDue() { return this.alarmAt; }
    async runAlarm() { this.alarmAt = null; await super.alarm(); }
    retained() {
      const sql = this.ctx.storage.sql;
      return {
        charges: sql.exec('SELECT send_id AS sendId, day, expires_at FROM quota_charges ORDER BY day, send_id').toArray(),
        newest: sql.exec<{ sendId: string }>('SELECT DISTINCT send_id AS sendId FROM quota_newest').toArray().map(r => r.sendId),
        released: sql.exec<{ sendId: string }>('SELECT DISTINCT send_id AS sendId FROM quota_released').toArray().map(r => r.sendId),
        alerts: sql.exec('SELECT * FROM quota_gate_alerts ORDER BY day').toArray(),
      };
    }
    failNext(method: string, times = 1) { this.failures.set(method, times); }
    private fail(method: string) {
      const count = this.failures.get(method) ?? 0;
      if (count > 0) {
        this.failures.set(method, count - 1);
        throw new Error(`Fixture quota ${method} failure`);
      }
    }
    override async reserve(...args: Parameters<QuotaPort['reserve']>) { this.fail('reserve'); return super.reserve(...args); }
    override async confirm(...args: Parameters<QuotaPort['confirm']>) { this.fail('confirm'); return super.confirm(...args); }
    override async release(...args: Parameters<QuotaPort['release']>) { this.fail('release'); return super.release(...args); }
    override async resetAt() { this.fail('resetAt'); return super.resetAt(); }
    balances() {
      return this.ctx.storage.sql.exec<{ ws: string; mb: string; sendId: string; epoch: number; attempt: number; day: string; charges: number }>(`
        SELECT ws, mb, send_id AS sendId, epoch, attempt, day, count(*) AS charges FROM quota_charges
        WHERE expires_at IS NULL OR expires_at > ? GROUP BY ws, mb, send_id, epoch, attempt, day
        ORDER BY ws, mb, send_id, epoch, attempt, day`, this.now()).toArray();
    }
  };
}

export const FixtureSendQuota = quotaFixture(env => env.INITIAL_TIME);
export default {
  async fetch(request: Request, env: { SEND_QUOTA: DurableObjectNamespace<InstanceType<typeof FixtureSendQuota>> }) {
    const { method, args } = await request.json<{ method: string; args: unknown[] }>();
    const quota = env.SEND_QUOTA.getByName('account') as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
    try { return Response.json(await quota[method](...args) ?? null); }
    catch (error) { return new Response((error as Error).message, { status: 500 }); }
  },
};
