import type { ConfirmAnswer } from '../../src/sweep-ledger.ts';
import type { Sweeper } from '../../src/sweeper-do.ts';
import type { Env, SweeperReferences } from '../../src/worker.ts';

// Written against Env, as a mailbox calls the binding. The typecheck compiles
// it, and the provisional holder tests run it against the real Durable Object.
export async function holdThenConfirm(env: Pick<Env, 'SWEEPER'>, workspaceId: string, digest: string, holder: string) {
  const sweeper = env.SWEEPER.getByName(workspaceId);
  const key: string = await sweeper.holdProvisional({ kind: 'raw', digest }, holder);
  const answers: ConfirmAnswer[] = await sweeper.confirm([{ key, holder }]);
  return { key, answers };
}

// The Durable Object implements every method the binding type promises.
type Implements<T extends SweeperReferences> = T;
export type SweeperImplementsBinding = Implements<Pick<Sweeper, keyof SweeperReferences>>;
