import { DurableObject } from 'cloudflare:workers';
import { workspaceMailBucket } from './directory.ts';
import { kofra } from './kofra.ts';
import { MailboxWork } from './mailbox-work.ts';
import { parseObjectKey, type ObjectKind } from './object-key.ts';
import { RETENTION_MS } from './reconcile.ts';
import { PROVISIONAL_TTL, SweepLedger, type ConfirmAnswer, type ConfirmEntry, type HoldTarget, type SendHolders, type SendRegistration,
  type SendReleaseMode } from './sweep-ledger.ts';
import { enabled, type Env } from './worker.ts';

const DISABLED_RECHECK_MS = 24 * 60 * 60_000;

export class Sweeper extends DurableObject<Env> {
  private readonly alarms = new MailboxWork();

  private ledger(): SweepLedger {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    return new SweepLedger(this.ctx.storage);
  }

  private async arm(at: number) {
    const scope = this.ctx.id.name;
    if (!scope) throw new Error('Sweeper workspace name missing');
    workspaceMailBucket(scope);
    if (!await this.ctx.storage.get('sweepWorkspace')) await this.ctx.storage.put('sweepWorkspace', scope);
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending > at) await this.ctx.storage.setAlarm(at);
  }

  async register(kind: ObjectKind, digest: string, holder: string): Promise<string> {
    return this.ledger().register(kind, digest, holder, Date.now());
  }
  async hold(key: string, holder: string): Promise<void> { this.ledger().hold(key, holder, Date.now()); }
  async holdProvisional(target: HoldTarget, holder: string): Promise<string> {
    const ledger = this.ledger();
    return this.alarms.run(async () => {
      const now = Date.now();
      // Arm before committing, as release does, so an expiry never lacks a wake-up.
      const due = Math.min(now + PROVISIONAL_TTL, ledger.nextSweepAt() ?? Infinity);
      await this.arm(this.env.MAIL_SWEEP_ENABLED === 'on' ? due : Math.max(due, now + DISABLED_RECHECK_MS));
      return ledger.holdProvisional(target, holder, now);
    });
  }
  // Only adds protection, so it needs no wake-up.
  async confirm(entries: ConfirmEntry[]): Promise<ConfirmAnswer[]> { return this.ledger().confirm(entries, Date.now()); }
  async release(key: string, holder: string): Promise<void> {
    const ledger = this.ledger();
    await this.alarms.run(async () => {
      const now = Date.now();
      if (parseObjectKey(key)) {
        // Arm before committing a release; a crash can cause an unnecessary wake-up
        // but cannot drop the sole wake-up for an eligible generation.
        const due = Math.min(now + RETENTION_MS, ledger.nextSweepAt() ?? Infinity);
        // While deletes are off an overdue ledger needs only the daily check, not a wake-up per release.
        await this.arm(this.env.MAIL_SWEEP_ENABLED === 'on' ? due : Math.max(due, now + DISABLED_RECHECK_MS));
      }
      ledger.release(key, holder, now);
    });
  }

  // Adds protection only, so it needs no wake-up.
  async registerSend(mailbox: string, sendId: string, digest: string, holders: SendHolders): Promise<SendRegistration> {
    return this.ledger().registerSend(mailbox, sendId, digest, holders, Date.now());
  }
  async releaseSend(mailbox: string, sendId: string, mode: SendReleaseMode): Promise<void> {
    const ledger = this.ledger();
    await this.alarms.run(async () => {
      const now = Date.now();
      // Arm before committing, as release does.
      const due = Math.min(now + RETENTION_MS, ledger.nextSweepAt() ?? Infinity);
      await this.arm(this.env.MAIL_SWEEP_ENABLED === 'on' ? due : Math.max(due, now + DISABLED_RECHECK_MS));
      ledger.releaseSend(mailbox, sendId, mode, now);
    });
  }

  // Repairs an absent wake-up for ledgers written before off-mode arming.
  async rearm(): Promise<void> {
    const ledger = this.ledger();
    await this.alarms.run(async () => {
      const next = ledger.nextSweepAt();
      if (next !== null) await this.arm(next);
    });
  }

  async alarm() {
    if (!enabled(this.env)) {
      // Keep a daily wake-up while the backend is off; a returning handler clears the alarm.
      const next = new SweepLedger(this.ctx.storage).nextSweepAt();
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + DISABLED_RECHECK_MS, next));
      return;
    }
    const ledger = this.ledger();
    if (this.env.MAIL_SWEEP_ENABLED !== 'on') {
      // Provisional expiry runs with the sweep, so while deletes are off no holder loses protection.
      await this.alarms.run(async () => {
        const next = ledger.nextSweepAt();
        if (next === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(Math.max(Date.now() + DISABLED_RECHECK_MS, next));
      });
      return;
    }
    const workspace = await this.ctx.storage.get<string>('sweepWorkspace');
    if (!workspace) return;
    const now = Date.now();
    await this.alarms.run(() => this.ctx.storage.setAlarm(now + 60_000));
    await ledger.sweep(now, kofra(this.env, workspace).deleteGeneration, Date.now);
    await this.alarms.run(async () => {
      const next = ledger.nextSweepAt();
      if (next === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    });
  }
}
