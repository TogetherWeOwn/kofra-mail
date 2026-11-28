import type { LinkDatabase } from '../../../packages/link-storage/src/store.ts';
import { LINK_UPLOAD_LIFE, objectMultipart, type LinkObject, type LinkUploadEnv } from './link-uploads.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const LEASE = 5 * MINUTE;
const PAGE = 12;
export type LinkDisposition = { state: 'retry' | 'unused' | 'closed' } | { state: 'held'; next: number | null };

/** The D1 row is the deletion fence and outlives the irreversible provider call. */
export async function sweepLinkObjects(db: LinkDatabase, env: LinkUploadEnv, now: number,
  refs: (ws: string, mb: string, id: string) => Promise<LinkDisposition>): Promise<void> {
  const { results } = await db.prepare(`SELECT * FROM link_objects WHERE sweep_at IS NOT NULL AND sweep_at <= ? ORDER BY sweep_at LIMIT ?`)
    .bind(now, PAGE).all<LinkObject>();
  await Promise.all(results.map(row => sweep(db, env, row, now, refs)));
  // A previous UTC day cannot be reopened by a request carrying an earlier clock.
  await db.prepare(`DELETE FROM link_daily_bytes WHERE rowid IN
    (SELECT rowid FROM link_daily_bytes WHERE day < ? ORDER BY day LIMIT 100)`).bind(Math.floor(now / DAY) - 2).run();
}

async function sweep(db: LinkDatabase, env: LinkUploadEnv, row: LinkObject, now: number,
  refs: (ws: string, mb: string, id: string) => Promise<LinkDisposition>): Promise<void> {
  const ids = [row.workspace_id, row.mailbox_id, row.id] as const;
  const where = 'workspace_id = ? AND mailbox_id = ? AND id = ?';
  if (row.state === 'deleted') {
    // Liveness requires positive registration, so absence remains a fence after pruning.
    await db.prepare(`DELETE FROM link_objects WHERE ${where} AND state = 'deleted' AND idem_expires <= ?`).bind(...ids, now).run();
    return;
  }
  const token = crypto.randomUUID();
  const due = row.created_at + LINK_UPLOAD_LIFE;
  const mustCheckDeleting = !!row.abandoned || now >= due || row.state === 'deleting';
  const claim = await db.prepare(`UPDATE link_objects SET lease = ?, lease_until = ?, sweep_at = ?,
    state = CASE WHEN ? AND state <> 'retiring' THEN 'deleting' ELSE state END
    WHERE ${where} AND wake_rev = ? AND state = ? AND sweep_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`)
    .bind(token, now + LEASE, now + LEASE, mustCheckDeleting ? 1 : 0, ...ids, row.wake_rev, row.state, now, now).run();
  if (claim.meta.changes !== 1) return;
  const owned = `${where} AND lease = ?`;
  const args = [...ids, token] as const;
  // An attach or revoke can move the clock forward after this job took its lease. A newer wake wins.
  const reschedule = async (when: number | null, state: 'complete' | null, confirmed: number | null) => {
    await db.prepare(`UPDATE link_objects SET state = COALESCE(?, state), confirmed = COALESCE(?, confirmed),
      confirm_since = CASE WHEN ? IS NULL THEN confirm_since ELSE NULL END,
      abandoned = CASE WHEN ? = 1 THEN 0 ELSE abandoned END,
      sweep_at = CASE WHEN wake_rev = ? THEN ? ELSE MIN(COALESCE(sweep_at, ?), ?) END,
      lease = NULL, lease_until = NULL WHERE ${owned}`)
      .bind(state, confirmed, confirmed, confirmed, row.wake_rev, when, now, now, ...args).run();
  };
  const alert = (code: 'link_confirm_stale' | 'delete_failed') => db.prepare(`INSERT OR IGNORE INTO mail_alerts (key, source, created_at)
    VALUES (?, ?, ?)`).bind(`${code}:${row.id}`, `mail:${code}`, now).run();
  let retiring = row.state === 'retiring';
  try {
    if (!retiring) {
      let ref = await refs(row.workspace_id, row.mailbox_id, row.id);
      if (ref.state === 'retry') {
        if (!row.confirmed && row.confirm_since !== null && now - row.confirm_since >= HOUR) await alert('link_confirm_stale');
        await reschedule(now + MINUTE, null, null);
        return;
      }
      if (ref.state === 'held') {
        await reschedule(ref.next, 'complete', 1);
        return;
      }
      if (ref.state === 'unused' && !mustCheckDeleting) {
        await reschedule(due, null, 0);
        return;
      }
      if (!mustCheckDeleting) {
        // Close the attach gate first, then ask again. A draft that was already
        // attaching either committed first in the mailbox work lane or will refuse.
        const closing = await db.prepare(`UPDATE link_objects SET state = 'deleting' WHERE ${owned} AND wake_rev = ?`)
          .bind(...args, row.wake_rev).run();
        if (closing.meta.changes !== 1) { await reschedule(now, null, null); return; }
        ref = await refs(row.workspace_id, row.mailbox_id, row.id);
        if (ref.state === 'retry') { await reschedule(now + MINUTE, null, null); return; }
        if (ref.state === 'held') { await reschedule(ref.next, 'complete', 1); return; }
      }
      const fenced = await db.prepare(`UPDATE link_objects SET state = 'retiring', delete_since = COALESCE(delete_since, ?) WHERE ${owned} AND state = 'deleting'`)
        .bind(now, ...args).run();
      if (fenced.meta.changes !== 1) return;
      retiring = true;
    }
    const provider = await objectMultipart(db, env, row);
    if (row.provider_upload) await provider.abort(row.provider_upload);
    const sessions = await provider.sessions();
    for (const id of sessions.ids.slice(0, 4)) await provider.abort(id);
    // Never infer absence from a truncated listing or leave a batch of sessions unprocessed.
    if (sessions.truncated || sessions.ids.length > 4) throw new Error('Link upload listing incomplete');
    const object = await provider.head();
    if (row.version_id && object && row.version_id !== object.version) throw new Error('Link object version changed');
    if (object || row.version_id) {
      await provider.delete(row.version_id ?? object?.version ?? null);
      if (await provider.head()) throw new Error('Link object still present');
    }
    await db.prepare(`UPDATE link_objects SET state = 'deleted', sweep_at = ?, lease = NULL, lease_until = NULL WHERE ${owned} AND state = 'retiring'`)
      .bind(Math.max(row.idem_expires, now + DAY), ...args).run();
  } catch {
    if (retiring && row.delete_since !== null && now - row.delete_since >= DAY && row.alert_at === null) {
      await alert('delete_failed');
      await db.prepare(`UPDATE link_objects SET alert_at = ? WHERE ${owned}`).bind(now, ...args).run();
    } else if (!retiring && !row.confirmed && row.confirm_since !== null && now - row.confirm_since >= HOUR) await alert('link_confirm_stale');
    await reschedule(now + (retiring ? 5 * MINUTE : MINUTE), null, null);
  }
}
