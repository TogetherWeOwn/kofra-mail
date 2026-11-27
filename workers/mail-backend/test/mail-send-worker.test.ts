import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { ClaimAnswer } from '../src/mailbox-send-dispatch.ts';
import type { SendFence } from '../src/mailbox-send-quota.ts';
import { TAKE_SEND_NOTICES } from '../src/reconcile-send-results.ts';
import type { DispatchOutcome, ResultNotice } from '../src/send-consumer.ts';
import { DLQ, HOUR, MB, MINUTE, SEND, WS, startMailSendFixture } from './fixtures/mail-send.ts';

type Fixture = Awaited<ReturnType<typeof startMailSendFixture>>;
const run = async (body: (h: Fixture) => Promise<void>, options?: Parameters<typeof startMailSendFixture>[0]) => {
  const h = await startMailSendFixture(options);
  try { await body(h); } finally { await h.close(); }
};
const TO = 'person@example.net', SUBJECT = 'Secret project title', BODY = 'Private body sentinel';
async function queued(h: Fixture, name: string, principal: 'member' | 'other' = 'member') {
  const mail = h.as(principal);
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const draft = await mail.createDraft({ from: mailbox.primaryAddress, to: [{ email: TO }], cc: [], bcc: [],
    subject: SUBJECT, body: BODY, attachments: [] }, { idempotencyKey: `draft-${name}` });
  const send = await mail.sendDraft(draft.id, { idempotencyKey: `send-${name}`, ifMatch: draft.revision });
  await h.advance(10_000);
  return send.id;
}
const dispatch = (sendId: string) => ({ kind: 'dispatch' as const, ws: WS, mb: MB, sendId });
const result = (sendId: string, fence: SendFence): ResultNotice => ({ kind: 'result', ws: WS, mb: MB, sendId, fence });
const storedRows = (h: Fixture, id: string) => h.directoryRows(
  'SELECT notify_after, notify_failures FROM send_results WHERE mailbox_id = ? AND send_id = ?', MB, id,
);
const advanceTo = async (h: Fixture, time: number) => h.advance(time - await h.sends.now());
const assertSent = async (h: Fixture, id: string) => {
  assert.equal((await h.sendState(id)).row?.state, 'sent');
  assert.equal((await h.as('member').getSend(id)).state, 'sent');
  assert.deepEqual(await storedRows(h, id), []);
};

async function pendingProviderFact(h: Fixture, name: string) {
  const id = await queued(h, name);
  await h.consumer('failNext', 'recordResult');
  const stored = await h.consumer<DispatchOutcome>('consume', dispatch(id));
  assert.equal(stored.step, 'stored');
  assert.ok('fence' in stored);
  return { id, notice: result(id, stored.fence) };
}

test('every claim RPC fails until the native queue dead-letters; the drive row still re-drives the send', () => run(async h => {
  const id = await queued(h, 'native-dlq');
  const first = (await h.sends.queue()).find(m => m.sendId === id);
  assert.deepEqual(first, dispatch(id));
  await h.failClaims(4);
  await h.submit(dispatch(id));
  const timeout = new AbortController();
  try { await Promise.race([h.alerted, setTimeout(4_000, undefined, { signal: timeout.signal }).then(() => assert.fail('No DLQ alert after four failing claims'))]); }
  finally { timeout.abort(); }
  assert.equal(await h.failedClaims(), 4);
  assert.equal(h.providerCalls(), 0);
  const pending = await h.sendState(id);
  assert.equal(pending.row?.state, 'queued');
  assert.equal(pending.drive.length, 1);
  await advanceTo(h, pending.drive[0]);
  await h.sends.driveIdle();
  const redrives = (await h.sends.queue()).filter(m => m.sendId === id);
  assert.ok(redrives.length > 1, 'drive row sent another dispatch');
  assert.deepEqual(await h.batch(SEND, redrives.at(-1)), ['ack']);
  assert.equal(h.providerCalls(), 1);
  await assertSent(h, id);
}));

test('a restoring mailbox acknowledges an exact result notice without a queue retry', () => run(async h => {
  const { id, notice } = await pendingProviderFact(h, 'restore-ack');
  await h.beginRestore();
  await h.directoryChange('UPDATE send_results SET notify_after = 0 WHERE send_id = ?', id);
  assert.deepEqual(await h.batch(SEND, notice), ['ack']);
  assert.equal(h.providerCalls(), 0);
  assert.deepEqual(await storedRows(h, id), [{ notify_after: await h.sends.now() + 5 * MINUTE, notify_failures: 0 }]);
}));

test('a DLQ message never mutates the send and only acknowledges a redacted 2xx alert', () => run(async h => {
  const id = await queued(h, 'dlq-contract');
  const state = await h.sendState(id);
  const body = { ...dispatch(id), to: TO, subject: SUBJECT, body: BODY };
  h.alertStatuses.push(302, 503, 204);
  for (const action of ['retry', 'retry', 'ack']) {
    assert.deepEqual(await h.batch(DLQ, body), [action]);
    assert.deepEqual(await h.sendState(id), state);
  }
  assert.equal(h.alerts.length, 3);
  assert.equal(h.providerCalls(), 0);
  assert.equal(new Set(h.alerts.map(({ key }) => key)).size, 1, 'redeliveries carry the same alert key');
  assert.ok(h.alerts[0].key);
  assertRedacted(h);
}));

function assertRedacted(h: Fixture) {
  const observed = JSON.stringify({ logs: h.logs(), alerts: h.alerts, notices: h.notices });
  for (const value of [TO, SUBJECT, BODY]) assert.ok(!observed.includes(value), 'mail data escaped to a redacted surface');
}

test('100 earlier stored results for a restoring mailbox do not starve a ready mailbox', () => run(async h => {
  const { id, notice } = await pendingProviderFact(h, 'ready-after-page');
  await queued(h, 'restoring-page', 'other');
  await h.beginRestore('other');
  const now = await h.sends.now();
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, created_at, notify_after)
    SELECT ?, 'mailbox-b', ?, 0, value, 'accepted', ?, ? FROM json_each(?)`, WS, id, now - 2, now - 2,
  JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1)));
  await h.directoryChange('UPDATE send_results SET notify_after = ? WHERE mailbox_id = ? AND send_id = ?', now - 1, MB, id);
  await h.backendCron();
  assert.equal(h.notices.length, 101);
  assert.ok(h.notices.some(n => n.mb === MB && n.sendId === id));
  assert.deepEqual(await h.batch(SEND, notice), ['ack']);
  await assertSent(h, id);
  const stalled = h.notices.filter(n => n.mb === 'mailbox-b');
  for (const n of stalled) assert.deepEqual(await h.batch(SEND, n), ['ack']);
  h.notices.length = 0;
  await h.advance(MINUTE);
  await h.backendCron();
  assert.deepEqual(h.notices, [], 'at most one notice per restoring row per backoff step');
}));

test('the reconciler and the alert drain use bounded indexed ranges', () => run(async h => {
  const now = await h.sends.now();
  const notices = await h.directoryRows(`EXPLAIN QUERY PLAN ${TAKE_SEND_NOTICES}`,
    now, 128, now, 5 * MINUTE, HOUR, MINUTE);
  const noticePlan = notices.map(row => String(row.detail)).join('\n');
  assert.match(noticePlan, /SEARCH send_results USING COVERING INDEX send_results_notify \(notify_after<\?\)/);
  assert.match(noticePlan, /SEARCH send_results USING (?:COVERING )?INDEX sqlite_autoindex_send_results_1/);
  const alerts = await h.directoryRows(`EXPLAIN QUERY PLAN SELECT key FROM mail_alerts
    WHERE sent_at IS NULL AND created_at BETWEEN 0 AND ? ORDER BY created_at, key LIMIT ?`, now, 12);
  assert.ok(alerts.some(row => /SEARCH mail_alerts USING INDEX mail_alerts_unsent/.test(String(row.detail))));
}));

test('an orphaned notice deletes only the matching result when the mailbox directory entry is gone', () => run(async h => {
  const { id, notice } = await pendingProviderFact(h, 'orphan');
  await h.beginRestore();
  await h.directoryChange('DELETE FROM addresses WHERE workspace_id = ? AND target_id = ?', WS, MB);
  await h.directoryChange('DELETE FROM mailboxes WHERE workspace_id = ? AND id = ?', WS, MB);
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, created_at, notify_after)
    VALUES (?, ?, ?, ?, ?, 'accepted', 0, 0)`, WS, MB, id, notice.fence.epoch, notice.fence.attempt + 1);
  assert.deepEqual(await h.batch(SEND, notice), ['ack']);
  assert.deepEqual(await h.directoryRows('SELECT fence_attempt FROM send_results WHERE send_id = ? ORDER BY fence_attempt', id),
    [{ fence_attempt: notice.fence.attempt + 1 }]);
  assert.ok(h.logs().some(line => line.includes('send_result_orphan')));
}));

test('a late stored acceptance upgrades a cleaned-up send through the reconciler, and survives restore', () => run(async h => {
  const id = await queued(h, 'late-cleanup');
  await h.consumer('scriptEmail', [{ result: 'reject', code: 'E_INTERNAL_SERVER_ERROR' }]);
  const a = await h.consumer<DispatchOutcome>('consume', dispatch(id));
  assert.ok('fence' in a);
  assert.equal(a.step, 'recorded');
  await h.advance(30 * MINUTE);
  await h.consumer('scriptEmail', [{ result: 'reject', code: 'E_VALIDATION_ERROR' }]);
  assert.equal((await h.consumer<DispatchOutcome>('consume', dispatch(id))).step, 'recorded');
  await h.advance(MINUTE);
  const failed = await h.sendState(id);
  assert.equal(failed.row?.state, 'failed');
  assert.equal(failed.row?.finish_pending, 0);
  assert.deepEqual(failed.drive, []);
  const due = await h.sends.now();
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, created_at, notify_after)
    VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`, WS, MB, id, a.fence.epoch, a.fence.attempt, due - 5 * MINUTE, due);
  await h.backendCron();
  assert.deepEqual(h.notices, [result(id, a.fence)]);
  assert.deepEqual(await h.batch(SEND, h.notices[0]), ['ack']);
  await assertSent(h, id);
  assert.deepEqual((await h.sendState(id)).drive, []);
  await h.restore();
  await assertSent(h, id);
  assert.deepEqual((await h.sendState(id)).drive, []);
  assert.equal(h.providerCalls(), 0, 'a notice never invokes EMAIL');
}));

test('a long restore backs off its notice without re-enqueueing or dead-lettering', () => run(async h => {
  const { id, notice } = await pendingProviderFact(h, 'long-restore');
  await h.beginRestore();
  const due = await h.sends.now();
  await h.directoryChange('UPDATE send_results SET notify_after = ? WHERE send_id = ?', due, id);
  await h.backendCron();
  assert.deepEqual(h.notices, [notice]);
  h.notices.length = 0;
  assert.deepEqual(await h.batch(SEND, notice), ['ack']);
  assert.deepEqual(await storedRows(h, id), [{ notify_after: due + 5 * MINUTE, notify_failures: 0 }]);
  await h.backendCron();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.alerts, []);
}));

test('mail-send persists a provider fact before noticing it; the notice records it after restore', () => run(async h => {
  const id = await queued(h, 'after-restore');
  await h.failRecordOnce(1);
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 1);
  assert.equal((await storedRows(h, id)).length, 1);
  const [notice] = h.notices;
  assert.equal(notice.sendId, id);
  await h.restore();
  assert.notEqual((await h.sendState(id)).row?.state, 'sent');
  assert.deepEqual(await h.batch(SEND, notice), ['ack']);
  await assertSent(h, id);
  assert.equal(h.providerCalls(), 1);
}));

test('dropping every result notice after restore still records the stored fact through the drive row', () => run(async h => {
  const id = await queued(h, 'drop-all');
  await h.failRecordOnce(1);
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.notices.length, 1);
  h.notices.length = 0;
  await h.restore();
  await h.advance(6 * MINUTE);
  await assertSent(h, id);
  assert.equal(h.providerCalls(), 1);
}));

test('an unbound quota dependency never makes a provider call', () => run(async h => {
  const id = await queued(h, 'unbound-quota');
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 0);
  assert.equal((await h.sendState(id)).ledger[0].state, 'pending');
  await h.backendCron();
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].body, /send_quota_failed/);
}, { quota: false }));

const SEND_EVENT_CODES = [
  'send_outage', 'send_unknown_error', 'send_ambiguous_cap', 'send_deadline', 'send_held', 'send_result_unapplied',
  'send_result_stuck', 'send_quota_release', 'send_quota_failed', 'send_stale_release_failed', 'send_request_invalid', 'send_stalled',
];
const sources = (h: Fixture) => h.alerts.map(({ body }) => (JSON.parse(body) as { source: string }).source);
const stalledSource = 'mail:send_stalled';

test('every mailbox send-event code reaches the operator, once per UTC day across mailboxes', () => run(async h => {
  for (const code of SEND_EVENT_CODES) await h.sendEvent(code);
  await h.backendCron();
  assert.deepEqual(sources(h).sort(), SEND_EVENT_CODES.map(code => `mail:${code}`).sort());
  for (const { body, key } of h.alerts) {
    assert.match(key ?? '', /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(body).key, key);
    assert.equal(JSON.parse(body).environment, 'test');
    assert.equal(JSON.parse(body).count, 1);
    assert.equal(typeof JSON.parse(body).time, 'number');
  }
  for (const code of SEND_EVENT_CODES) await h.sendEvent(code, 'other');
  await h.backendCron();
  assert.equal(h.alerts.length, SEND_EVENT_CODES.length);
  await h.advance(24 * HOUR);
  await h.sendEvent('send_outage', 'other');
  await h.backendCron();
  assert.equal(h.alerts.length, SEND_EVENT_CODES.length + 1);
  assert.notEqual(h.alerts.at(-1)?.key, h.alerts[sources(h).indexOf('mail:send_outage')].key);
  assertRedacted(h);
}));

test('a rejected operator alert is retried with the same daily key and accepted once', () => run(async h => {
  h.alertStatuses.push(503, 204);
  await h.sendEvent('send_outage');
  await h.backendCron();
  await h.sendEvent('send_outage', 'other');
  await h.advance(MINUTE);
  await h.backendCron();
  await h.backendCron();
  assert.deepEqual(sources(h), ['mail:send_outage', 'mail:send_outage']);
  assert.equal(h.alerts[0].key, h.alerts[1].key);
}));

async function claim(h: Fixture, id: string) {
  const answer = await h.sendRpc<ClaimAnswer>('claimSend', id);
  assert.equal(answer.status, 'claimed');
  return answer;
}

test('five consecutive pre-Mark lease expiries raise send_stalled without using the crash cap; Mark clears the condition', () => run(async h => {
  const id = await queued(h, 'stall-count');
  let claimed = await claim(h, id);
  for (let i = 1; i <= 5; i++) {
    await advanceTo(h, claimed.leaseUntil + 30_000);
    claimed = await claim(h, id);
    await h.advance(MINUTE);
    await h.backendCron();
    assert.equal(sources(h).filter(source => source === stalledSource).length, i === 5 ? 1 : 0);
  }
  const stalled = await h.sendState(id);
  assert.equal(stalled.dispatch?.unfinished, 0);
  assert.equal(stalled.ledger[0].state, 'pending');
  assert.ok((await h.sends.activeAlerts()).includes('send_stalled'));
  const markedAt = await h.sends.now();
  assert.deepEqual(await h.sendRpc('markSend', id, claimed.fence, [0], claimed.release), { status: 'ok' });
  await h.advance(MINUTE);
  assert.ok(!(await h.sends.activeAlerts()).includes('send_stalled'));
  await advanceTo(h, markedAt + 24 * HOUR - MINUTE);
  await h.backendCron();
  assert.equal(sources(h).filter(source => source === stalledSource).length, 1);
  await advanceTo(h, markedAt + 24 * HOUR);
  await h.backendCron();
  assert.equal(sources(h).filter(source => source === stalledSource).length, 2);
}));

test('a released send that is never claimed alerts at 24 hours', () => run(async h => {
  const id = await queued(h, 'stall-no-claim');
  const release = await h.sends.now();
  await advanceTo(h, release + 24 * HOUR - MINUTE);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource));
  await advanceTo(h, release + 24 * HOUR);
  await h.backendCron();
  assert.deepEqual(sources(h), [stalledSource]);
  assert.equal((await h.sendState(id)).row?.state, 'queued');
  assert.equal((await h.sendState(id)).fences.length, 0);
}));

test('24 hours since release raises send_stalled after a late first claim; finishing clears the condition', () => run(async h => {
  const id = await queued(h, 'stall-age');
  const release = await h.sends.now();
  await h.advance(2 * HOUR);
  const claimed = await claim(h, id);
  // Abandon on an unavailable quota object; this is a stall, not an expired lease.
  await h.sendRpc('abandonClaim', id, claimed.fence, await h.sends.now() + MINUTE);
  await advanceTo(h, release + 24 * HOUR - MINUTE);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource));
  await advanceTo(h, release + 24 * HOUR);
  await h.backendCron();
  assert.ok(sources(h).includes(stalledSource));
  assert.ok((await h.sends.activeAlerts()).includes('send_stalled'));
  assert.equal((await h.sendState(id)).dispatch?.unfinished, 0);
  await h.directoryChange("UPDATE mailboxes SET user_id = 'new-admin' WHERE workspace_id = ? AND id = ?", WS, MB);
  assert.deepEqual(await h.sendRpc('claimSend', id), { status: 'refused' });
  await h.advance(MINUTE);
  assert.equal((await h.sendState(id)).row?.state, 'failed');
  assert.ok(!(await h.sends.activeAlerts()).includes('send_stalled'));
}));

test('outage payloads and logs omit provider data and mail content', () => run(async h => {
  const id = await queued(h, 'redaction');
  h.providerErrors.push('Secret_project_title');
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  await h.backendCron();
  const observed = JSON.stringify({ logs: h.logs(), alerts: h.alerts });
  assert.ok(!observed.includes('Secret_project_title'));
  assert.equal(h.alerts.length, 1);
  assertRedacted(h);
}));
