// Internal delivery (docs/m3-outbound-plan.md, section 2.4, release step 6;
// M3-8). A send's recipients in its own workspace are handed to the inbound
// pipeline through one handoff row, never through send(). The drive handler
// holds the raw object for the handoff, then writes the row in one statement
// that decides (the sender check inside the insert; the first row written is
// the decision). The pipeline expands an accepted handoff into ordinary
// single-mailbox `deliveries` rows: a plan written in one statement from the
// directory as it is then, a holder for each child before the rows, then the
// rows and the handoff's release flag in one batch. From then on every child
// follows the inbound rules unchanged.
import { sha256 } from './bytes.ts';
import { senderHolds } from './mailbox-send-sender.ts';
import { parseObjectKey } from './object-key.ts';
import type { SendRecord } from './mail-journal.ts';
import type { SweeperReferences } from './worker.ts';

export type HandoffStuckAlert = { code: 'handoff_stuck'; key: string };
export type HandoffSweeper = Pick<SweeperReferences, 'hold' | 'register' | 'releaseTombstoned'>;
export type HandoffStep = 'handoff:hold' | 'handoff:decide' | 'handoff:decided' | 'handoff:commit'
  | 'expand:plan' | 'expand:held' | 'expand:written' | 'expand:released';
// What the handoff and its expansion need. Every call is remote; none holds the mailbox's work lane.
export type HandoffPorts = {
  db: D1Database;
  sweeper(workspaceId: string): HandoffSweeper;
  put(workspaceId: string, key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  // Best effort: a child whose message is lost is due at once and the reconciler re-drives it.
  enqueue?(deliveryId: string): Promise<void>;
  // A test seam at each step; does nothing in production.
  checkpoint?(step: HandoffStep): Promise<void>;
  // The bound on one inline expansion in the drive handler (HANDOFF_CALL_MS when absent).
  callMs?: number;
};
// [ledger index, normalized local part, domain, the address as the sender wrote it]
export type HandoffAddress = [idx: number, local: string, domain: string, email: string];
export type HandoffRow = {
  key: string; workspaceId: string; mailboxId: string; sendId: string; rawKey: string; sender: string; addresses: HandoffAddress[];
  messageId: string; folderRev: number; decision: 'accepted' | 'rejected'; reason: 'invalid_sender' | 'link_expired' | null;
  createdAt: number; plan: string | null; expandedAt: number | null; releasePending: boolean; acknowledgedAt: number | null;
};

const DAY = 24 * 60 * 60_000;
// A handoff's tombstone outlives its expansion and the sender's acknowledgement by this long.
export const HANDOFF_TOMBSTONE_MS = 7 * DAY;
// The drive handler expands an accepted handoff at once; the reconciler only
// takes one that is still unexpanded (or unreleased) this long after.
export const HANDOFF_RETRY_MS = 5 * 60_000;
const HANDOFF_RETRY_MAX_MS = 60 * 60_000;
export const HANDOFF_PAGE = 12;
// A full page is followed by one more, taken after the first page's rows moved
// back, so one workspace's page of failing rows never delays another's past the
// run in which it falls due.
const HANDOFF_PAGES = 2;
// After this many attempts at one expansion or release, the operator is alerted once per handoff.
export const HANDOFF_STUCK_ATTEMPTS = 12;
const PRUNE_PAGE = 100;
// One reconciler sweeper or storage call; a workspace whose sweeper hangs never holds up another's.
export const HANDOFF_CALL_MS = 10_000;

export const handoffKey = (workspaceId: string, mailboxId: string, sendId: string) => `internal:${workspaceId}:${mailboxId}:${sendId}`;
export const handoffHolder = (key: string) => `handoff:${key}`;
// The longest handoff key: its holder must fit the sweeper's 256-character bound,
// and the table's CHECK matches. The supported maxima (workspace ids 58, mailbox
// ids 128 as the send path's quota scope bounds them, send ids 26) give 223.
export const HANDOFF_KEY_MAX = 256 - handoffHolder('').length;
export const deliveryHolder = (id: string) => `delivery:${id}`;

// M3-13 dependency. Release step 6.2 rejects a handoff with `link_expired` when
// a file link of the send is below its expiry floor. Revocable file links
// (M3-13) are not on main yet, so no send carries a link with an expiry and
// this floor always passes. M3-13 replaces it with the check of the frozen
// `expiresAt` values, made just before the decision statement.
export function handoffLinkFloorBelow(_record: SendRecord, _now: number): boolean {
  return false;
}

const COLUMNS = `key, workspace_id AS workspaceId, mailbox_id AS mailboxId, send_id AS sendId, raw_key AS rawKey, sender,
  addresses, message_id AS messageId, folder_rev AS folderRev, decision, reason, created_at AS createdAt, plan,
  expanded_at AS expandedAt, holder_release_pending AS releasePending, acknowledged_at AS acknowledgedAt`;

// Decide and write (release step 6.2): one statement. The link floor (?9)
// rejects without the directory; otherwise the section 1 sender statement
// decides, inside the insert. The first row written for the key is the
// decision: a later or still-in-flight insert is ignored.
const DECIDE = `INSERT OR IGNORE INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender, addresses, message_id,
    folder_rev, decision, reason, created_at, expand_retry_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0,
    CASE WHEN ?9 THEN 'rejected' WHEN d.ok THEN 'accepted' ELSE 'rejected' END,
    CASE WHEN ?9 THEN 'link_expired' WHEN d.ok THEN NULL ELSE 'invalid_sender' END,
    ?10, CASE WHEN ?9 OR NOT d.ok THEN NULL ELSE ?10 + ${HANDOFF_RETRY_MS} END
  FROM (SELECT ${senderHolds('?2', '?3', '?11', '?6')} AS ok) AS d`;

export type HandoffInput = {
  key: string; workspaceId: string; mailboxId: string; sendId: string; rawKey: string; sender: string; ownerUserId: string;
  addresses: HandoffAddress[]; messageId: string; linkFloorBelow: boolean; now: number;
};

export async function writeHandoff(db: D1Database, input: HandoffInput): Promise<void> {
  await db.prepare(DECIDE).bind(input.key, input.workspaceId, input.mailboxId, input.sendId, input.rawKey, input.sender,
    JSON.stringify(input.addresses), input.messageId, input.linkFloorBelow ? 1 : 0, input.now, input.ownerUserId).run();
}

export async function readHandoff(db: D1Database, key: string): Promise<HandoffRow | null> {
  const row = await db.withSession('first-primary').prepare(`SELECT ${COLUMNS} FROM internal_handoffs WHERE key = ?`).bind(key)
    .first<Omit<HandoffRow, 'addresses' | 'releasePending'> & { addresses: string; releasePending: number }>();
  if (!row) return null;
  return { ...row, addresses: JSON.parse(row.addresses) as HandoffAddress[], releasePending: row.releasePending === 1 };
}

// Plan (expansion step 1): one statement resolves every address inside the
// write, only among mailboxes of the handoff's own workspace (read from the
// same row, never a bound parameter), by the inbound routing rules. The first
// plan written wins; every expander uses the stored plan.
const PLAN = `UPDATE internal_handoffs SET plan = (
    SELECT json_group_array(json_array(r.idx, r.mailbox)) FROM (
      SELECT CAST(json_extract(j.value, '$[0]') AS INTEGER) AS idx,
        (SELECT a.target_id FROM domains AS original
          JOIN domains AS destination ON destination.workspace_id = original.workspace_id
            AND destination.id = coalesce(original.alias_of, original.id) AND destination.kind <> 'alias'
          JOIN addresses AS a ON a.address_norm = (json_extract(j.value, '$[1]') || '@' || destination.name)
            AND a.workspace_id = destination.workspace_id
          JOIN mailboxes AS m ON m.workspace_id = a.workspace_id AND m.id = a.target_id
          WHERE original.name = json_extract(j.value, '$[2]') AND original.workspace_id = internal_handoffs.workspace_id) AS mailbox
      FROM json_each(internal_handoffs.addresses) AS j ORDER BY j.key) AS r)
  WHERE key = ?1 AND decision = 'accepted' AND plan IS NULL`;

// Write (expansion step 3): every planned child as an ordinary single-mailbox
// row, conditional on the stored plan and on the handoff not yet expanded,
// together with the expanded mark and the release flag (one batch).
const INSERT_CHILDREN = `INSERT OR IGNORE INTO deliveries (id, workspace_id, envelope_from, envelope_to, resolved_mailbox_ids, group_post_ids,
    raw_key, auth_results, state, attempts, next_attempt_at, created_at, source, kind, file_message_id, file_folder_rev)
  SELECT json_extract(c.value, '$.id'), h.workspace_id, h.sender, json_extract(c.value, '$.to'), json_array(json_extract(c.value, '$.mailbox')),
    '[]', json_extract(c.value, '$.raw'), NULL, 'pending', 0, ?3, h.created_at, 'internal', json_extract(c.value, '$.kind'),
    CASE json_extract(c.value, '$.kind') WHEN 'file_sent' THEN h.message_id END,
    CASE json_extract(c.value, '$.kind') WHEN 'file_sent' THEN h.folder_rev END
  FROM internal_handoffs AS h, json_each(?2) AS c
  WHERE h.key = ?1 AND h.decision = 'accepted' AND h.plan = ?4 AND h.expanded_at IS NULL`;
const MARK_EXPANDED = `UPDATE internal_handoffs SET expanded_at = ?2, holder_release_pending = 1, release_retry_at = ?3
  WHERE key = ?1 AND decision = 'accepted' AND plan = ?4 AND expanded_at IS NULL`;
const CLEAR_RELEASE = `UPDATE internal_handoffs SET holder_release_pending = 0, release_retry_at = NULL,
    prune_after = CASE WHEN acknowledged_at IS NOT NULL THEN max(acknowledged_at, expanded_at) + ${HANDOFF_TOMBSTONE_MS} END
  WHERE key = ? AND holder_release_pending = 1`;
// Finish rule step 3: the sender's acknowledgement mark, scoped to the sending mailbox.
const ACKNOWLEDGE = `UPDATE internal_handoffs SET acknowledged_at = coalesce(acknowledged_at, ?4),
    prune_after = CASE WHEN decision = 'rejected' THEN coalesce(acknowledged_at, ?4) + ${HANDOFF_TOMBSTONE_MS}
      WHEN expanded_at IS NOT NULL AND holder_release_pending = 0 THEN max(coalesce(acknowledged_at, ?4), expanded_at) + ${HANDOFF_TOMBSTONE_MS} END
  WHERE key = ?1 AND workspace_id = ?2 AND mailbox_id = ?3`;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();

// A child's deterministic id in the delivery-id format: the handoff's time,
// then 80 bits of SHA-256 over (handoff key, child kind, mailbox id or
// recipient index), so a notice never collides with another notice or with a mailbox child.
export async function childDeliveryId(key: string, kind: 'mailbox' | 'ndn', value: string, createdAt: number): Promise<string> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt >= 2 ** 48) throw new Error('Invalid handoff time');
  let time = '';
  for (let rest = createdAt, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${key}\n${kind}\n${value}`)));
  let bits = 0n;
  for (const byte of digest.subarray(0, 10)) bits = (bits << 8n) | BigInt(byte);
  let tail = '';
  for (let i = 0; i < 16; i++, bits >>= 5n) tail = CROCKFORD[Number(bits & 31n)] + tail;
  return time + tail;
}

export type HandoffChild = { id: string; mailbox: string; kind: 'deliver' | 'file_sent'; to: string; holder: string; notice?: { idx: number; email: string } };

// Every child follows from the stored plan alone: one per resolved mailbox (a
// `file_sent` child for the sending mailbox), and one non-delivery notice to the
// sending mailbox per address that resolves nowhere.
export async function planChildren(row: HandoffRow): Promise<HandoffChild[]> {
  const entries: unknown = row.plan === null ? null : JSON.parse(row.plan);
  const emails = new Map(row.addresses.map(([idx, , , email]) => [idx, email]));
  if (!Array.isArray(entries) || entries.length !== row.addresses.length || entries.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
      !emails.has(entry[0]) || (entry[1] !== null && (typeof entry[1] !== 'string' || !entry[1])))) {
    throw new Error('Invalid handoff plan');
  }
  const plan = (entries as [number, string | null][]).slice().sort((a, b) => a[0] - b[0]);
  const mailboxes = new Map<string, number>();
  const unresolved: number[] = [];
  for (const [idx, mailbox] of plan) {
    if (mailbox === null) unresolved.push(idx);
    else if (!mailboxes.has(mailbox)) mailboxes.set(mailbox, idx);
  }
  const children: HandoffChild[] = [];
  for (const [mailbox, idx] of [...mailboxes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const id = await childDeliveryId(row.key, 'mailbox', mailbox, row.createdAt);
    children.push({ id, mailbox, kind: mailbox === row.mailboxId ? 'file_sent' : 'deliver', to: emails.get(idx)!, holder: deliveryHolder(id) });
  }
  for (const idx of unresolved) {
    const id = await childDeliveryId(row.key, 'ndn', String(idx), row.createdAt);
    children.push({ id, mailbox: row.mailboxId, kind: 'deliver', to: row.sender, holder: deliveryHolder(id), notice: { idx, email: emails.get(idx)! } });
  }
  return children;
}

const rfc5322Date = (at: number) => new Date(at).toUTCString().replace(/GMT$/, '+0000');

// A non-delivery notice for one address that resolved nowhere, built only from
// the handoff and the recipient index, so every retry builds the same bytes.
export function nonDeliveryNotice(row: Pick<HandoffRow, 'sendId' | 'sender' | 'createdAt'>, idx: number, email: string): Uint8Array<ArrayBuffer> {
  const domain = row.sender.slice(row.sender.lastIndexOf('@') + 1);
  const text = [
    `From: Mail Delivery System <mailer-daemon@${domain}>`,
    `To: <${row.sender}>`,
    'Subject: Undeliverable: your message could not be delivered',
    `Date: ${rfc5322Date(row.createdAt)}`,
    `Message-ID: <ndn-${idx}.${row.sendId.toLowerCase()}@${domain}>`,
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    'Your message could not be delivered to this recipient:',
    '',
    `    ${email}`,
    '',
    'The address no longer receives mail in this workspace.',
    '',
  ].join('\r\n');
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export type ExpandOutcome = 'expanded' | 'rejected' | 'missing';

// The pipeline's expansion of one handoff, idempotent from the stored plan: a
// crash anywhere repeats with the same ids and holders, and a second expander
// running at the same time writes nothing the first did not.
export async function expandHandoff(ports: HandoffPorts, key: string, now: number): Promise<ExpandOutcome> {
  await ports.checkpoint?.('expand:plan');
  await ports.db.prepare(PLAN).bind(key).run();
  const row = await readHandoff(ports.db, key);
  if (!row) return 'missing';
  if (row.decision !== 'accepted') return 'rejected';
  const children = await planChildren(row);
  if (row.expandedAt === null) {
    const sweeper = ports.sweeper(row.workspaceId);
    const planned: { id: string; mailbox: string; to: string; raw: string; kind: HandoffChild['kind'] }[] = [];
    // Hold before write: each child's holder on its raw object; a notice's bytes registered and stored first.
    for (const child of children) {
      let raw = row.rawKey;
      if (child.notice) {
        const bytes = nonDeliveryNotice(row, child.notice.idx, child.notice.email);
        const digest = await sha256(bytes);
        raw = await sweeper.register('raw', digest, child.holder);
        const parsed = parseObjectKey(raw);
        if (parsed?.kind !== 'raw' || parsed.digest !== digest) throw new Error('Invalid registered notice key');
        await ports.put(row.workspaceId, raw, bytes);
      } else await sweeper.hold(row.rawKey, child.holder);
      planned.push({ id: child.id, mailbox: child.mailbox, to: child.to, raw, kind: child.kind });
    }
    await ports.checkpoint?.('expand:held');
    await ports.db.batch([
      ports.db.prepare(INSERT_CHILDREN).bind(key, JSON.stringify(planned), now, row.plan),
      ports.db.prepare(MARK_EXPANDED).bind(key, now, now + HANDOFF_RETRY_MS, row.plan),
    ]);
    await ports.checkpoint?.('expand:written');
  }
  if (row.expandedAt === null || row.releasePending) await releaseHandoffHolder(ports, row);
  for (const child of children) await ports.enqueue?.(child.id).catch(() => console.error({ code: 'handoff_enqueue_failed' }));
  return 'expanded';
}

// Expansion's last step: the handoff's own holder, tombstoned, then the flag.
async function releaseHandoffHolder(ports: HandoffPorts, row: Pick<HandoffRow, 'key' | 'workspaceId' | 'rawKey'>): Promise<void> {
  await ports.sweeper(row.workspaceId).releaseTombstoned(row.rawKey, handoffHolder(row.key));
  await ports.checkpoint?.('expand:released');
  await ports.db.prepare(CLEAR_RELEASE).bind(row.key).run();
}

// Finish rule step 3 for a send with internal recipients: a rejected
// handoff's holder is released here, tombstoned, before its row is marked; an
// accepted one's is released by its expansion. Absent for a send that ended
// before its handoff (a release-time failure).
export async function acknowledgeHandoff(ports: Pick<HandoffPorts, 'db' | 'sweeper'>, key: string, workspaceId: string, mailboxId: string,
  now: number): Promise<void> {
  const row = await readHandoff(ports.db, key);
  if (!row || row.workspaceId !== workspaceId || row.mailboxId !== mailboxId || row.acknowledgedAt !== null) return;
  if (row.decision === 'rejected') await ports.sweeper(workspaceId).releaseTombstoned(row.rawKey, handoffHolder(key));
  await ports.db.prepare(ACKNOWLEDGE).bind(key, workspaceId, mailboxId, now).run();
}

const backoff = (column: string) => `min(${HANDOFF_RETRY_MAX_MS}, ${HANDOFF_RETRY_MS} * (1 << min(${column}, 16)))`;
// Reserve a bounded page before acting, moving each row's retry ahead with
// backoff in the same statement, so rows that keep failing move back and never
// starve another workspace's.
const TAKE_EXPANSIONS = `WITH due AS MATERIALIZED (
    SELECT key FROM internal_handoffs INDEXED BY internal_handoffs_expand
    WHERE decision = 'accepted' AND expanded_at IS NULL AND expand_retry_at <= ?1 ORDER BY expand_retry_at, key LIMIT ?2)
  UPDATE internal_handoffs SET expand_retry_at = ?1 + ${backoff('expand_attempts')}, expand_attempts = expand_attempts + 1
  WHERE key IN (SELECT key FROM due) RETURNING key, expand_attempts AS attempts`;
const TAKE_RELEASES = `WITH due AS MATERIALIZED (
    SELECT key FROM internal_handoffs INDEXED BY internal_handoffs_release
    WHERE holder_release_pending = 1 AND release_retry_at <= ?1 ORDER BY release_retry_at, key LIMIT ?2)
  UPDATE internal_handoffs SET release_retry_at = ?1 + ${backoff('release_attempts')}, release_attempts = release_attempts + 1
  WHERE key IN (SELECT key FROM due) RETURNING key, workspace_id AS workspaceId, raw_key AS rawKey, release_attempts AS attempts`;
// Our own stall alerts instead of failing (section 2.4): one alert row per handoff.
const STUCK_ALERT = `INSERT OR IGNORE INTO mail_alerts (key, source, created_at) VALUES ('handoff_stuck:' || ?1, 'mail:handoff_stuck', ?2)`;
// A handoff with a pending release is never deleted.
const PRUNE = `DELETE FROM internal_handoffs WHERE key IN (
    SELECT key FROM internal_handoffs INDEXED BY internal_handoffs_prune
    WHERE prune_after IS NOT NULL AND prune_after <= ?1 ORDER BY prune_after, key LIMIT ?2)
  AND holder_release_pending = 0`;

export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Handoff call timed out')), ms); })]);
  } finally { clearTimeout(timer); }
}

// The one-minute reconciler's part: expansions the drive handler could not
// finish, handoff holders whose release failed, and tombstones past their time.
async function takePages<T extends { key: string; attempts: number }>(ports: HandoffPorts, statement: string, now: number): Promise<T[]> {
  const taken: T[] = [];
  for (let page = 0; page < HANDOFF_PAGES; page++) {
    const { results } = await ports.db.prepare(statement).bind(now, HANDOFF_PAGE).all<T>();
    taken.push(...results);
    if (results.length < HANDOFF_PAGE) break;
  }
  // A failed alert insert never holds up the taken rows; the next attempt, still past the threshold, inserts it again.
  const stuck = taken.filter(row => row.attempts >= HANDOFF_STUCK_ATTEMPTS);
  if (stuck.length) {
    await ports.db.batch(stuck.map(row => ports.db.prepare(STUCK_ALERT).bind(row.key, now)))
      .catch(() => console.error({ code: 'handoff_stuck_alert_failed', count: stuck.length }));
  }
  return taken;
}

export async function reconcileHandoffs(ports: HandoffPorts, now: number, callMs = HANDOFF_CALL_MS): Promise<{ errors: number }> {
  let errors = 0;
  const expansions = await takePages<{ key: string; attempts: number }>(ports, TAKE_EXPANSIONS, now);
  await Promise.all(expansions.map(({ key }) => bounded(expandHandoff(ports, key, now), callMs).catch(() => { errors++; })));
  const releases = await takePages<{ key: string; workspaceId: string; rawKey: string; attempts: number }>(ports, TAKE_RELEASES, now);
  await Promise.all(releases.map(row => bounded(releaseHandoffHolder(ports, row), callMs).catch(() => { errors++; })));
  await ports.db.prepare(PRUNE).bind(now, PRUNE_PAGE).run();
  if (errors) console.error({ code: 'handoff_reconcile_partial', count: errors });
  return { errors };
}
