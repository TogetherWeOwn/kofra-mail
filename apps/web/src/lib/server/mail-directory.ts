import { hasHeaderControl, LIMITS, MailApiError, problem } from '@kofra/mail-contract';
import type { AdminMailbox, Alias, Domain, Identity, MailErrorCode, Member, Operation, Problem, ServiceState } from '@kofra/mail-contract';
import type { OperationResult } from './mail-api.ts';

interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface DirectoryDatabase {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
  withSession?(constraint: 'first-primary'): Pick<DirectoryDatabase, 'prepare' | 'batch'>;
}
interface MailboxRow { id: string; user_id: string; primary_address: string; display_name: string | null }
interface AliasRow { address_norm: string; target_id: string; send_as_policy: ServiceState }
interface DomainRow { id: string; name: string; kind: Domain['kind']; routing_state: ServiceState; sending_state: ServiceState; alias_name: string | null }
type Bind = (string | number | null)[];
const fail = (code: MailErrorCode, fields: Partial<Pick<Problem, 'errors' | 'limit'>> = {}): never => { throw new MailApiError(problem(code, fields)); };
const id = () => crypto.randomUUID();
const memberOrder = (row: { name: string; id: string }) => [row.name, row.id] as const;
const encodeCursor = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decodeCursor = (value: string) => JSON.parse(new TextDecoder('utf-8').decode(
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)),
));

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return fail('invalid_request', { errors: [{ field, code: 'invalid' }] });
  if (hasHeaderControl(value)) return fail('invalid_header', { errors: [{ field, code: 'invalid' }] });
  if (!value || new TextEncoder().encode(value).byteLength > max) return fail('invalid_request', { errors: [{ field, code: value ? 'too_long' : 'required' }] });
  return value;
}
function address(value: unknown, field: string, { existing = false } = {}): string {
  const result = text(value, field, LIMITS.addressBytes).toLowerCase();
  // Inbound strips plus tags for routing, so a tag cannot be a separate directory address.
  // RFC 2047 encoded words are not allowed in an addr-spec; sends refuse them too. A
  // lookup of an existing address (delete) still accepts one stored before this rule.
  if (!/^[a-z0-9.!#$%&'*\/=?^_`{|}~-]+@[a-z0-9][a-z0-9.-]*\.[a-z0-9]+$/.test(result) || (!existing && result.split('@')[0].includes('=?'))) return fail('invalid_request', { errors: [{ field, code: 'invalid' }] });
  return result;
}
function domainName(value: unknown, field: string): string {
  const result = text(value, field, 253).toLowerCase();
  if (!result.includes('.') || result.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return fail('invalid_request', { errors: [{ field, code: 'invalid' }] });
  return result;
}
function asDomain(row: DomainRow): Domain {
  return { name: row.name, kind: row.kind, routing: row.routing_state, sending: row.sending_state, ...(row.alias_name && { aliasOf: row.alias_name }) };
}
function asAlias(row: AliasRow): Alias { return { address: row.address_norm, mailboxId: row.target_id, sendAs: row.send_as_policy }; }
function cursor(value: unknown, scope: string): [string, string] {
  if (value === undefined) return ['', ''];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) return fail('invalid_cursor');
  try {
    const [tag, a, b] = decodeCursor(value);
    if (tag !== scope || typeof a !== 'string' || typeof b !== 'string') return fail('invalid_cursor');
    return [a, b];
  } catch { return fail('invalid_cursor'); }
}
function page<T>(items: T[], limit: number, scope: string, key: (item: T) => readonly [string, string]) {
  const last = items[limit - 1];
  return { items: items.slice(0, limit), nextCursor: items.length > limit
    ? encodeCursor([scope, ...key(last)])
    : null };
}
const mailboxSelect = `SELECT m.id, m.user_id, m.primary_address, p.display_name
  FROM mailboxes m LEFT JOIN mailbox_profiles p ON p.workspace_id = m.workspace_id AND p.mailbox_id = m.id`;
const domainSelect = `SELECT d.id, d.name, d.kind, d.routing_state, d.sending_state, a.name AS alias_name
  FROM domains d LEFT JOIN domains a ON a.workspace_id = d.workspace_id AND a.id = d.alias_of`;

type Action = { body: AdminMailbox | Alias | Domain; statements: Statement[] };

/** Every query is either an indexed lookup, bounded page, or confined to the local account fixture. */
export class Directory {
  private readonly db: DirectoryDatabase;
  private readonly ws: string;
  private readonly members?: (workspaceId: string) => Promise<Omit<Member, 'hasMailbox'>[]>;

  constructor(db: DirectoryDatabase, workspaceId: string, members?: Directory['members']) {
    // Mailbox ownership and alias revocations must be visible on the next request.
    this.db = db.withSession?.('first-primary') ?? db;
    this.ws = workspaceId;
    this.members = members;
  }
  private prep(sql: string, ...values: Bind) { return this.db.prepare(sql).bind(...values); }
  byUser(userId: string) {
    return this.prep('SELECT id, primary_address FROM mailboxes WHERE workspace_id = ? AND user_id = ?', this.ws, userId)
      .first<Pick<MailboxRow, 'id' | 'primary_address'>>();
  }
  private byId(mailboxId: string) { return this.prep(`${mailboxSelect} WHERE m.workspace_id = ? AND m.id = ?`, this.ws, mailboxId).first<MailboxRow>(); }
  private domain(name: string) { return this.prep(`${domainSelect} WHERE d.workspace_id = ? AND d.name = ?`, this.ws, name).first<DomainRow>(); }
  private async aliases(mailboxId: string): Promise<Alias[]> {
    const { results } = await this.prep(`SELECT address_norm, target_id, send_as_policy FROM addresses
      WHERE workspace_id = ? AND target_id = ? AND kind = 'alias' ORDER BY address_norm LIMIT ?`, this.ws, mailboxId, LIMITS.aliasesPerMailbox).all<AliasRow>();
    return results.map(asAlias);
  }
  async identities(mailboxId: string): Promise<Identity[]> {
    const mailbox = await this.byId(mailboxId);
    if (!mailbox) return fail('not_found');
    const name = mailbox.display_name ?? '';
    const primary = await this.prep(`SELECT send_as_policy FROM addresses
      WHERE address_norm = ? AND workspace_id = ? AND target_kind = 'mailbox' AND target_id = ? AND kind = 'primary'`,
    mailbox.primary_address, this.ws, mailboxId).first<{ send_as_policy: string }>();
    const identities: Identity[] = [];
    // As for aliases, a legacy policy is draftable but does not authorize sending.
    if (primary && primary.send_as_policy !== 'off') {
      identities.push({ email: mailbox.primary_address, name, kind: 'primary', primary: true,
        sendAs: primary.send_as_policy === 'active' ? 'active' : 'pending' });
    }
    const aliases = (await this.aliases(mailboxId)).filter((alias) => alias.sendAs !== 'off');
    return [...identities, ...aliases.map(({ address: email, sendAs }): Identity => ({ email, name, kind: 'alias', primary: false, sendAs: sendAs === 'active' ? 'active' : 'pending' }))];
  }
  private async asMailbox(row: MailboxRow): Promise<AdminMailbox> {
    return { id: row.id, primaryAddress: row.primary_address, displayName: row.display_name ?? '', ownerUserId: row.user_id, aliases: await this.aliases(row.id) };
  }
  private async requireMember(value: unknown): Promise<string> {
    const member = text(value, '/ownerUserId', 64);
    if (!(await this.members?.(this.ws))?.some((row) => row.id === member)) fail('not_found');
    return member;
  }
  private async requireDomain(addressNorm: string): Promise<void> {
    const domain = await this.domain(addressNorm.split('@')[1]);
    if (!domain || domain.kind === 'alias') fail('domain_not_in_workspace');
  }
  private async addressTaken(addressNorm: string): Promise<boolean> {
    return Boolean(await this.prep('SELECT 1 FROM addresses WHERE address_norm = ?', addressNorm).first() ||
      await this.prep('SELECT 1 FROM mailboxes WHERE primary_address = ?', addressNorm).first());
  }
  private async action(op: Operation, input: Record<string, unknown>): Promise<Action> {
    const fields = op === 'addDomain' ? ['name', 'kind', 'aliasOf'] : op === 'createMailbox'
      ? ['primaryAddress', 'displayName', 'ownerUserId'] : ['mailboxId', 'address', 'sendAs'];
    if (Object.keys(input).some((field) => !fields.includes(field))) return fail('unknown_field');
    if (op === 'addDomain') {
      const name = domainName(input.name, '/name');
      const kind = input.kind;
      if (kind !== 'secondary' && kind !== 'alias') return fail('invalid_request');
      if (await this.prep('SELECT 1 FROM domains WHERE name = ?', name).first()) return fail('domain_exists');
      const target = kind === 'alias' ? await this.domain(domainName(input.aliasOf, '/aliasOf')) : null;
      if (kind === 'alias' && (!target || target.kind === 'alias')) return fail('domain_not_in_workspace');
      if (kind === 'secondary' && input.aliasOf !== undefined) return fail('invalid_request');
      return { body: { name, kind, routing: 'pending', sending: 'pending', ...(target && { aliasOf: target.name }) }, statements: [
        this.prep(`INSERT INTO domains (id,workspace_id,name,kind,alias_of,routing_state,sending_state)
          VALUES (?,?,?,?,?,'pending','pending')`, id(), this.ws, name, kind, target?.id ?? null),
      ] };
    }
    if (op === 'createMailbox') {
      const primaryAddress = address(input.primaryAddress, '/primaryAddress');
      const displayName = text(input.displayName, '/displayName', LIMITS.displayNameBytes);
      const ownerUserId = await this.requireMember(input.ownerUserId);
      await this.requireDomain(primaryAddress);
      if (await this.addressTaken(primaryAddress) || await this.byUser(ownerUserId)) return fail('address_taken');
      const mailboxId = id();
      return { body: { id: mailboxId, primaryAddress, displayName, ownerUserId, aliases: [] }, statements: [
        this.prep('INSERT INTO mailboxes (id,workspace_id,user_id,primary_address) VALUES (?,?,?,?)', mailboxId, this.ws, ownerUserId, primaryAddress),
        this.prep('INSERT INTO mailbox_profiles (workspace_id,mailbox_id,display_name) VALUES (?,?,?)', this.ws, mailboxId, displayName),
        this.prep(`INSERT INTO addresses (address_norm,workspace_id,target_kind,target_id,kind,send_as_policy)
          VALUES (?,?,'mailbox',?,'primary','pending')`, primaryAddress, this.ws, mailboxId),
      ] };
    }
    const mailboxId = text(input.mailboxId, '/mailboxId', 64);
    if (!await this.byId(mailboxId)) return fail('not_found');
    const alias = address(input.address, '/address');
    if (typeof input.sendAs !== 'boolean') return fail('invalid_request');
    await this.requireDomain(alias);
    if (await this.addressTaken(alias)) return fail('address_taken');
    if ((await this.aliases(mailboxId)).length >= LIMITS.aliasesPerMailbox) return fail('limit_reached', { limit: LIMITS.aliasesPerMailbox });
    const sendAs = input.sendAs ? 'pending' : 'off';
    return { body: { address: alias, mailboxId, sendAs }, statements: [
      this.prep(`INSERT INTO addresses (address_norm,workspace_id,target_kind,target_id,kind,send_as_policy)
        VALUES (?,?,'mailbox',?,'alias',?)`, alias, this.ws, mailboxId, sendAs),
    ] };
  }
  private async idempotent(op: Operation, input: Record<string, unknown>, key: string): Promise<OperationResult> {
    const bytes = new TextEncoder().encode(JSON.stringify([op, Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const lookup = async () => {
      const row = await this.prep('SELECT fingerprint, result FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at > ?', this.ws, key, now)
        .first<{ fingerprint: string; result: string }>();
      if (!row) return;
      if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused');
      return { body: JSON.parse(row.result), replayed: true };
    };
    const replay = await lookup();
    if (replay) return replay;
    try {
      const action = await this.action(op, input);
      await this.db.batch([
        this.prep('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at <= ?', this.ws, key, now),
        this.prep('INSERT INTO directory_api_keys (workspace_id,key,fingerprint,result,expires_at) VALUES (?,?,?,?,?)',
          this.ws, key, fingerprint, JSON.stringify(action.body), now + LIMITS.idempotencyRetentionSeconds * 1000),
        ...action.statements,
      ]);
      return { body: action.body };
    } catch (error) {
      const raced = await lookup();
      if (raced) return raced;
      // Re-validate after a racing request; don't expose database exception details.
      if (!(error instanceof MailApiError)) await this.action(op, input);
      throw error;
    }
  }
  async run(op: Operation, params: Record<string, string>, input: Record<string, unknown>, idempotencyKey?: string): Promise<OperationResult> {
    const limit = (input.limit as number | undefined) ?? LIMITS.pageSizeDefault;
    const scope = JSON.stringify([this.ws, op, limit]);
    switch (op) {
      case 'listDomains': {
        const { results } = await this.prep(`${domainSelect} WHERE d.workspace_id = ? ORDER BY d.name`, this.ws).all<DomainRow>();
        return { body: { items: results.map(asDomain) } };
      }
      case 'listMailboxes': {
        const [after, afterId] = cursor(input.cursor, scope);
        const { results } = await this.prep(`${mailboxSelect} WHERE m.workspace_id = ? AND (m.primary_address,m.id) > (?,?)
          ORDER BY m.primary_address,m.id LIMIT ?`, this.ws, after, afterId, limit + 1).all<MailboxRow>();
        return { body: page(await Promise.all(results.map((row) => this.asMailbox(row))), limit, scope, (row) => [row.primaryAddress, row.id]) };
      }
      case 'listMembers': {
        const [name, afterId] = cursor(input.cursor, scope);
        const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
        const members = (await this.members?.(this.ws) ?? []).filter((row) => row.name > name || (row.name === name && row.id > afterId))
          .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)).slice(0, limit + 1);
        const items = await Promise.all(members.map(async (row) => ({ ...row, hasMailbox: Boolean(await this.byUser(row.id)) })));
        return { body: page(items, limit, scope, memberOrder) };
      }
      case 'addDomain': case 'createMailbox': case 'createAlias':
        if (!idempotencyKey) return fail('precondition_required');
        return this.idempotent(op, input, idempotencyKey);
      case 'updateMailbox': {
        const prior = await this.byId(params.mailboxId);
        if (!prior) return fail('not_found');
        const statements: Statement[] = [];
        if (input.ownerUserId !== undefined) {
          const owner = await this.requireMember(input.ownerUserId);
          const existing = await this.byUser(owner);
          if (existing && existing.id !== prior.id) return fail('address_taken');
          statements.push(this.prep('UPDATE mailboxes SET user_id = ? WHERE workspace_id = ? AND id = ?', owner, this.ws, prior.id));
        }
        if (input.displayName !== undefined) statements.push(this.prep(`INSERT INTO mailbox_profiles (workspace_id,mailbox_id,display_name)
          VALUES (?,?,?) ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET display_name=excluded.display_name`,
        this.ws, prior.id, text(input.displayName, '/displayName', LIMITS.displayNameBytes)));
        if (statements.length) await this.db.batch(statements);
        return { body: await this.asMailbox((await this.byId(prior.id)) ?? prior) };
      }
      case 'deleteAlias':
        await this.db.batch([this.prep(`DELETE FROM addresses WHERE workspace_id = ? AND address_norm = ? AND kind = 'alias'`, this.ws, address(params.address, '/address', { existing: true }))]);
        return {};
      default: return fail('not_found');
    }
  }
}
