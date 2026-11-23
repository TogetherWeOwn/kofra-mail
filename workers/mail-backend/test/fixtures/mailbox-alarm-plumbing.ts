import { DurableObject } from 'cloudflare:workers';
import { Mailbox } from '../../src/mailbox-do.ts';
import { MailboxIndex } from '../../src/mailbox-index.ts';
import { MailboxRecovery, readyLife, restoringLife, SNAPSHOT_INTERVAL_MS, type Lifecycle } from '../../src/mailbox-recovery.ts';
import type { Env } from '../../src/worker.ts';

const scope = { workspaceId: 'workspace', mailboxId: 'mailbox' };

export class AlarmPlumbing extends Mailbox {
  private readonly trace: { snapshot: boolean; failures: number; lists: number };

  constructor(ctx: DurableObjectState, env: Env) {
    const trace = { snapshot: false, failures: 0, lists: 0 };
    const state = env.MAIL_STATE;
    const put = (async (key: string, body: string, options?: R2PutOptions) => {
      if (trace.snapshot && key.includes('/snapshots/')) {
        trace.failures++;
        throw new Error('Synthetic snapshot failure');
      }
      return state.put(key, body, options);
    }) as R2Bucket['put'];
    super(ctx, { ...env, MAIL_STATE: { put, get: ((key: string) => state.get(key)) as R2Bucket['get'],
      list: options => { trace.lists++; return state.list(options); },
      delete: keys => state.delete(keys) } as R2Bucket });
    this.trace = trace;
  }

  private localIndex() {
    return new MailboxIndex(this.ctx.storage, {
      get: async () => { throw new Error('Unexpected raw fetch'); }, put: async () => {},
      register: async () => { throw new Error('Unexpected object registration'); }, hold: async () => {}, release: async () => {},
    }, this.ctx.id.toString());
  }

  async setup(mode: 'ready' | 'missing' | 'restoring') {
    const index = this.localIndex();
    const now = Date.now();
    const incarnation = crypto.randomUUID();
    index.setLifecycle({ state: 'init', scope, incarnation });
    let life: Lifecycle;
    if (mode === 'ready') {
      const etag = await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString()).create(incarnation);
      if (!etag) throw new Error('Fixture manifest exists');
      life = { ...readyLife(scope, incarnation, etag, 1, now), nextSnapshotAt: 0,
        lastSnapshotAt: now - 2 * SNAPSHOT_INTERVAL_MS - 1000 };
    } else {
      life = mode === 'missing' ? { state: 'missing', scope, incarnation, since: now, failures: 0 }
        : restoringLife(scope, incarnation, now);
    }
    index.setLifecycle(life);
    return this.ctx.id.toString();
  }

  // Drive the real handler explicitly so background alarms cannot race test checkpoints.
  override async alarm() {}
  async run(failSnapshot = false) {
    this.trace.snapshot = failSnapshot;
    this.trace.failures = 0;
    this.trace.lists = 0;
    try { await super.alarm(); } finally { this.trace.snapshot = false; }
    return this.trace.failures;
  }

  async listCalls() { return this.trace.lists; }

  async obligations() {
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT code, since, sent_at FROM mailbox_alerts ORDER BY code').toArray());
  }

  async labels() { return JSON.stringify(this.ctx.storage.sql.exec('SELECT id, name FROM labels ORDER BY id').toArray()); }

  async addLabel(id: string) { this.localIndex().setLabel(id, id); }

  async seedLabels(count: number) {
    const index = this.localIndex();
    for (let i = 0; i < count; i++) index.setLabel(`label-${i}`, `Label ${i}`);
  }

  async setSnapshotDeadline(at: number) {
    const index = this.localIndex();
    const life = index.lifecycle<Lifecycle>();
    if (life?.state !== 'ready') throw new Error('Expected a ready fixture');
    index.setLifecycle({ ...life, nextSnapshotAt: at });
  }

  async alarmAt() { return this.ctx.storage.getAlarm(); }
}

export class UnusedSweeper extends DurableObject {}
export { FixtureMailbox, FixtureSweeper } from './mailbox-worker.ts';

export default {};
