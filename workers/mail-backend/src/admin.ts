import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceMailBucket } from './directory.ts';
import { isDeliveryId, Outbox } from './outbox.ts';
import { enabled, type Env } from './worker.ts';

// Internal entrypoint for operators. It has no route and is reachable only
// through a service binding that names it.
export class MailAdmin extends WorkerEntrypoint<Env> {
  // Returns a failed delivery to pending with a fresh attempt budget. A delivery
  // in any other state is left unchanged and false is returned.
  async redriveDelivery(id: string): Promise<boolean> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    if (!isDeliveryId(id)) throw new Error('Invalid delivery id');
    return new Outbox(this.env.DIRECTORY).redrive(id, Date.now());
  }

  // Restores a workspace sweeper's wake-up from its ledger; idempotent.
  async rearmSweeper(workspaceId: string): Promise<void> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    workspaceMailBucket(workspaceId);
    const sweeper = this.env.SWEEPER.getByName(workspaceId) as unknown as { rearm(): Promise<void> };
    await sweeper.rearm();
  }
}
