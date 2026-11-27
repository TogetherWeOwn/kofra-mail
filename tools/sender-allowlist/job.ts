import { CloudflareMail, isRecord } from './cloudflare.ts';

const DIRECTORY_CAP = 500;
export const SELECT_ADDRESSES = 'SELECT address_norm, workspace_id, send_as_policy FROM addresses ORDER BY address_norm LIMIT ?';
export const SELECT_DOMAINS = 'SELECT name, workspace_id, kind, sending_state FROM domains ORDER BY name LIMIT ?';

type Address = { address_norm: string; workspace_id: string; send_as_policy: string };
type Domain = { name: string; workspace_id: string; kind: string; sending_state: string };
export type Deploy = (list: string[]) => Promise<string>;

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1) : '';
}

export function senderList(addresses: Address[], domains: Domain[]): string[] {
  const eligible = new Map(domains.filter(({ kind, sending_state }) => kind !== 'alias' && sending_state === 'active')
    .map(({ name, workspace_id }) => [name, workspace_id]));
  return [...new Set(addresses.filter(({ address_norm, workspace_id, send_as_policy }) => {
    const domain = domainOf(address_norm);
    return (send_as_policy === 'pending' || send_as_policy === 'active') && domain !== '' && eligible.get(domain) === workspace_id;
  }).map(({ address_norm }) => address_norm))].sort();
}

async function readRows<K extends string>(client: CloudflareMail, sql: string, cap: number, columns: readonly K[]) {
  const { results } = await client.query(sql, [String(cap + 1)]);
  if (!Array.isArray(results)) throw new Error('Invalid D1 rows');
  if (results.length > cap) throw new Error('Directory row cap exceeded');
  return results.map((row: unknown) => {
    if (!isRecord(row) || !columns.every((column) => typeof row[column] === 'string')) throw new Error('Invalid D1 row');
    return row as Record<K, string>;
  });
}

const LOWER = (values: string) => `WITH candidates(address_norm, workspace_id) AS (VALUES ${values})
  UPDATE addresses SET send_as_policy = 'pending' FROM candidates
  WHERE addresses.address_norm = candidates.address_norm AND addresses.workspace_id = candidates.workspace_id
    AND addresses.send_as_policy = 'active'`;

// Match the read's workspace as well as its address, and recheck domain eligibility at mutation time.
const PROMOTE = (values: string) => `WITH candidates(address_norm, workspace_id, domain) AS (VALUES ${values})
  UPDATE addresses SET send_as_policy = 'active' FROM candidates
  JOIN domains ON domains.name = candidates.domain AND domains.workspace_id = candidates.workspace_id
    AND domains.kind <> 'alias' AND domains.sending_state = 'active'
  WHERE addresses.address_norm = candidates.address_norm AND addresses.workspace_id = candidates.workspace_id
    AND addresses.send_as_policy = 'pending'`;

async function updateRows(client: CloudflareMail, sql: (values: string) => string, rows: string[][], width: number) {
  const size = Math.floor(100 / width);
  const rowPlaceholder = `(${Array.from({ length: width }, () => '?').join(', ')})`;
  let changes = 0;
  for (let start = 0; start < rows.length; start += size) {
    const batch = rows.slice(start, start + size);
    const result = await client.query(sql(batch.map(() => rowPlaceholder).join(', ')), batch.flat());
    const count = isRecord(result.meta) ? result.meta.changes : undefined;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > batch.length) {
      throw new Error('Invalid D1 change count');
    }
    changes += count;
  }
  return changes;
}

export class DeploymentError extends Error {
  readonly exitCode: 4 | 5;

  constructor(exitCode: 4 | 5, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function runSenderAllowlist(client: CloudflareMail, deploy?: Deploy, cap = DIRECTORY_CAP) {
  if (!Number.isInteger(cap) || cap < 0 || cap > DIRECTORY_CAP) throw new Error('Invalid directory row cap');
  const addresses = await readRows(client, SELECT_ADDRESSES, cap, ['address_norm', 'workspace_id', 'send_as_policy']);
  const domains = await readRows(client, SELECT_DOMAINS, cap, ['name', 'workspace_id', 'kind', 'sending_state']);
  const list = senderList(addresses, domains);
  const pending = addresses.filter(({ send_as_policy }) => send_as_policy === 'pending');
  const active = addresses.filter(({ send_as_policy }) => send_as_policy === 'active');
  const counts = { pending: pending.length, active: active.length, listed: list.length, lowered: 0, promoted: 0, domains: domains.length };
  if (!deploy) return counts;

  const listed = new Set(list);
  counts.lowered = await updateRows(client, LOWER, active.filter(({ address_norm }) => !listed.has(address_norm))
    .map(({ address_norm, workspace_id }) => [address_norm, workspace_id]), 2);
  let version: string;
  try {
    version = await deploy(list);
  } catch {
    throw new DeploymentError(4, 'Worker deployment failed');
  }
  try {
    if (!(await client.isActiveVersion(version))) throw new Error();
  } catch {
    throw new DeploymentError(5, 'Could not verify active deployment');
  }
  counts.promoted = await updateRows(client, PROMOTE, pending.filter(({ address_norm }) => listed.has(address_norm))
    .map(({ address_norm, workspace_id }) => [address_norm, workspace_id, domainOf(address_norm)]), 3);
  return counts;
}
