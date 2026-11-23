import { DurableObject } from 'cloudflare:workers';
import { kofra, type KofraConfig } from '../../src/kofra.ts';
import { ObjectMissingError } from '../../src/object-errors.ts';
import { SweepLedger } from '../../src/sweep-ledger.ts';

export class DeleteConfirmation extends DurableObject<KofraConfig> {
  private client() { return kofra(this.env, 'workspace'); }

  async remove(key: string) {
    try { await this.client().deleteGeneration(key); return 'confirmed'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  async getResult(key: string) {
    try { await this.client().get(key); return 'found'; }
    catch (error) {
      if (error instanceof ObjectMissingError) return 'missing';
      return error instanceof Error ? error.message : String(error);
    }
  }

  async retireCandidate(now: number) {
    const ledger = new SweepLedger(this.ctx.storage);
    const key = ledger.register('raw', 'a'.repeat(64), 'holder', now);
    ledger.release(key, 'holder', now);
    return key;
  }

  async sweepAt(now: number) { await new SweepLedger(this.ctx.storage).sweep(now, this.client().deleteGeneration); }
  async next() { return new SweepLedger(this.ctx.storage).nextSweepAt(); }
}

export default {};
