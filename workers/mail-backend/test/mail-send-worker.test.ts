import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { ClaimAnswer } from '../src/mailbox-send-dispatch.ts';
import type { SendFence } from '../src/mailbox-send-quota.ts';
import { TAKE_SEND_NOTICES } from '../src/reconcile-send-results.ts';
import { isSendEventCode } from '../src/send-alert-events.ts';
import type { DispatchOutcome, ResultNotice } from '../src/send-consumer.ts';
import { DLQ, HOUR, MB, MINUTE, SEND, WS, quotaDay, startMailSendFixture } from './fixtures/mail-send.ts';

type Fixture = Awaited<ReturnType<typeof startMailSendFixture>>;
const run = async (body: (h: Fixture) => Promise<void>, options?: Parameters<typeof startMailSendFixture>[0]) => {
  const h = await startMailSendFixture(options);
  try {
    await body(h);
    if (options?.realQuota) {
      assert.equal(h.providerStarts.length, h.providerCalls(), 'every provider call has a captured start');
      for (const { grant, now } of h.providerStarts) {
        assert.ok(grant && now < grant.deadline, 'every provider call starts within a real authorization window');
        const state = await h.sendState(grant.sendId);
        const fence = state.fences.find(row => row.epoch === grant.fence.epoch && row.attempt === grant.fence.attempt);
        assert.ok(fence?.authorized && now < fence.lease_until, 'every provider call starts under an authorized live lease');
      }
    }
  } finally { await h.close(); }
};
const TO = 'person@example.net', SUBJECT = 'Secret project title', BODY = 'Private body sentinel';
async function queued(h: Fixture, name: string, principal: 'member' | 'other' = 'member', to = [TO]) {
  const mail = h.as(principal);
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const draft = await mail.createDraft({ from: mailbox.primaryAddress, to: to.map(email => ({ email })), cc: [], bcc: [],
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

test('a dispatch during restore is acknowledged and the drive sends exactly once after recovery', () => run(async h => {
  const id = await queued(h, 'restore-dispatch');
  await h.beginRestore();
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 0);
  let redrive;
  for (let slice = 0; slice < 5 && !redrive; slice++) {
    const timers = (await h.timers()).filter(timer => timer.kind === 'journal_flush' || timer.ref === id);
    assert.ok(timers.length, 'restore or drive has a timer');
    await advanceTo(h, Math.max(await h.sends.now(), Math.min(...timers.map(timer => timer.due_at))));
    await h.sends.driveIdle();
    redrive = (await h.sends.queue()).find(entry => entry.sendId === id);
  }
  assert.deepEqual(redrive, dispatch(id));
  assert.deepEqual(await h.batch(SEND, redrive), ['ack']);
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
  await h.backendCron();
  assert.deepEqual(h.alerts, []);
  assert.equal((await h.sendState(id)).fences.length, 1, 'no new claim');
}));

test('dropping every result notice after restore still records the stored fact through the drive row', () => run(async h => {
  const id = await queued(h, 'drop-all');
  await h.failRecordOnce(1);
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.notices.length, 1);
  h.notices.length = 0;
  await h.restore();
  await h.sends.driveIdle();
  const now = await h.sends.now();
  await h.directoryChange('UPDATE send_results SET notify_after = ? WHERE send_id = ?', now, id);
  h.noticeStatuses.push(503);
  await h.backendCron();
  // The cron UPDATE committed even though the queue send failed. A second tick
  // cannot take the same row early; the mailbox drive can still take it at due.
  assert.deepEqual(await storedRows(h, id), [{ notify_after: now + 5 * MINUTE, notify_failures: 0 }]);
  await h.backendCron();
  assert.deepEqual(h.notices, []);
  await h.advance(4 * MINUTE);
  await h.backendCron();
  assert.deepEqual(h.notices, []);
  await h.advance(2 * MINUTE);
  await assertSent(h, id);
  await h.backendCron();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.providerCalls(), 1);
  assert.equal((await h.sendState(id)).fences.length, 1, 'the drive never makes an empty claim');
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

test('a send-event enqueue rejects an invalid alert environment', () => run(async h => {
  await assert.rejects(h.sendEvent('send_outage'));
  assert.deepEqual(await h.directoryRows('SELECT key FROM mail_alerts'), []);
}, { environment: 'invalid environment' }));

test('a committed outbound alert survives a crash before the fast-path flush', () => run(async h => {
  const id = await queued(h, 'alert-record-crash');
  await h.crashAfterRecordCommit();
  h.providerErrors.push('E_EMAIL_SENDING_NOT_READY');
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal((await h.sendState(id)).fences[0].outcome, 'outage');
  assert.deepEqual(await h.directoryRows('SELECT key FROM mail_alerts'), []);
  await h.advance(MINUTE);
  await h.backendCron();
  assert.deepEqual(sources(h), ['mail:send_outage']);
  assert.equal(h.providerCalls(), 1);
}));

test('a one-shot outbound event survives an unavailable D1 alert insert', () => run(async h => {
  const id = await queued(h, 'alert-write-fails');
  await h.directoryChange(`CREATE TRIGGER fixture_no_send_alert BEFORE INSERT ON mail_alerts
    WHEN NEW.source = 'mail:send_unknown_error' BEGIN SELECT RAISE(ABORT, 'fixture refused send alert'); END`);
  h.providerErrors.push('E_UNRECOGNIZED');
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  await h.backendCron();
  assert.deepEqual(sources(h), []);
  await h.directoryChange('DROP TRIGGER fixture_no_send_alert');
  await h.advance(16 * MINUTE);
  await h.backendCron();
  assert.deepEqual(sources(h), ['mail:send_unknown_error']);
  assert.equal(h.providerCalls(), 1);
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
  const releasedAt = await h.sends.now();
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
  assert.deepEqual(await h.sendRpc('markSend', id, claimed.fence, [0], claimed.release), { status: 'ok' });
  await h.advance(MINUTE);
  assert.ok(!(await h.sends.activeAlerts()).includes('send_stalled'));
  await advanceTo(h, releasedAt + 24 * HOUR - MINUTE);
  await h.backendCron();
  assert.equal(sources(h).filter(source => source === stalledSource).length, 1);
  await advanceTo(h, releasedAt + 24 * HOUR);
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

for (const marked of [false, true]) test(`restoring a ${marked ? 'sending' : 'queued'} send starts a fresh advisory stall clock without losing the send`, () => run(async h => {
  const id = await queued(h, 'stall-restore');
  if (marked) {
    const claimed = await claim(h, id);
    assert.deepEqual(await h.sendRpc('markSend', id, claimed.fence, [0], claimed.release), { status: 'ok' });
  }
  const releasedAt = await h.sends.now();
  await h.advance(23 * HOUR);
  await h.restore();
  await h.advance(0);
  await h.sends.driveIdle();
  const restoredAt = await h.sends.now();
  assert.equal((await h.sendState(id)).row?.state, marked ? 'sending' : 'queued');
  await advanceTo(h, releasedAt + 24 * HOUR);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource), 'the pre-restore clock is not carried over');
  await advanceTo(h, restoredAt + 24 * HOUR);
  await h.backendCron();
  assert.deepEqual(sources(h), [stalledSource]);
  await h.quota('setDay', 'restored-day', await h.sends.now() + 24 * HOUR);
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.equal(h.providerCalls(), 1);
  await assertSent(h, id);
}));

test('mixed sends do not alert after all external recipients are terminal', () => run(async h => {
  const id = await queued(h, 'stall-mixed', 'member', [TO, 'other@example.com']);
  assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
  assert.deepEqual((await h.sendState(id)).ledger.map(({ kind, state }) => [kind, state]), [['external', 'sent'], ['internal', 'pending']]);
  await h.advance(25 * HOUR);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource), 'nothing external is stalled');
}));

test('repeated Mark and abandon without authorization still alerts after 24 hours', () => run(async h => {
  const id = await queued(h, 'stall-after-mark');
  for (let hour = 0; hour < 25; hour++) {
    const claimed = await claim(h, id);
    assert.deepEqual(await h.sendRpc('markSend', id, claimed.fence, [0], claimed.release), { status: 'ok' });
    await h.sendRpc('abandonClaim', id, claimed.fence, await h.sends.now() + HOUR);
    await h.advance(HOUR);
    await h.backendCron();
    assert.equal(sources(h).filter(source => source === stalledSource).length, hour >= 23 ? 1 : 0);
  }
  assert.equal(h.providerCalls(), 0);
  assert.equal((await h.sendState(id)).dispatch?.unfinished, 0);
  assert.equal(JSON.parse(h.alerts[0].body).title, 'An outbound send has stalled');
}));

test('a worker with no EMAIL binding still raises the stall alert', () => run(async h => {
  const id = await queued(h, 'stall-missing-binding');
  for (let hour = 0; hour < 25; hour++) {
    assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
    await h.advance(HOUR);
    await h.quota('setDay', `binding-hour-${hour}`, await h.sends.now() + 24 * HOUR);
  }
  await h.backendCron();
  assert.ok(sources(h).includes(stalledSource));
  assert.equal(h.providerCalls(), 0);
  assert.equal((await h.sendState(id)).ledger[0].state, 'pending');
}, { email: false }));

test('deliberate quota waits do not count toward the stall age', () => run(async h => {
  const id = await queued(h, 'stall-delay');
  const release = await h.sends.now();
  const claimed = await claim(h, id);
  const wait = 8 * HOUR;
  assert.deepEqual(await h.sendRpc('delaySend', id, claimed.fence, 'gate', release + wait - 30_000),
    { status: 'delayed', until: release + wait });
  await advanceTo(h, release + 24 * HOUR);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource));
  await advanceTo(h, release + 24 * HOUR + wait);
  await h.backendCron();
  assert.ok(sources(h).includes(stalledSource));
}));

test('an immediate abandon cannot erase an already reached fifth pre-Mark expiry', () => run(async h => {
  const id = await queued(h, 'stall-reached-streak');
  let claimed = await claim(h, id);
  for (let round = 0; round < 5; round++) {
    // No alarm observes the fifth expiry before the new claim does.
    await h.advance(claimed.leaseUntil + 30_000 - await h.sends.now(), false, false);
    claimed = await claim(h, id);
  }
  await h.sendRpc('abandonClaim', id, claimed.fence, await h.sends.now() + MINUTE);
  await h.advance(MINUTE);
  await h.backendCron();
  assert.deepEqual(sources(h), [stalledSource]);
}));

test('a reported abandon breaks the consecutive pre-Mark expiry streak', () => run(async h => {
  const id = await queued(h, 'stall-broken-streak');
  let claimed = await claim(h, id);
  for (let round = 0; round < 4; round++) {
    await advanceTo(h, claimed.leaseUntil + 30_000);
    claimed = await claim(h, id);
  }
  await h.sendRpc('abandonClaim', id, claimed.fence, await h.sends.now() + MINUTE);
  await h.advance(MINUTE);
  claimed = await claim(h, id);
  await advanceTo(h, claimed.leaseUntil + 30_000);
  await claim(h, id);
  await h.advance(MINUTE);
  await h.backendCron();
  assert.ok(!sources(h).includes(stalledSource));
}));

for (const [provider, code, limit] of [
  ['E_EMAIL_SENDING_NOT_READY', 'send_outage', 1],
  ['E_UNRECOGNIZED', 'send_unknown_error', 1],
  ['E_INTERNAL_SERVER_ERROR', 'send_ambiguous_cap', 3],
  ['E_RATE_LIMIT_EXCEEDED', 'send_deadline', 90],
] as const) test(`provider outcomes reach the operator as ${code}`, () => run(async h => {
  const id = await queued(h, code);
  for (let round = 0; round < limit; round++) {
    h.providerErrors.push(provider);
    assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
    const state = await h.sendState(id);
    if (state.row?.state === 'failed' || round + 1 === limit) break;
    await advanceTo(h, Number(state.dispatch?.next_attempt_at));
    await h.quota('setDay', `operator-${round}`, await h.sends.now() + 24 * HOUR);
  }
  await h.backendCron();
  assert.deepEqual(sources(h), [`mail:${code}`]);
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

const gateCode = 'send_quota_gate_hit';
const quotaCharges = (h: Fixture) => h.quota<{ sendId: string; day: string; charges: number }[]>('balances');

test('cross-worker real quota shares a gate and delivers one redacted operator alert per quota day', () => run(async h => {
  const first = await queued(h, 'real-quota-first');
  assert.deepEqual(await h.batch(SEND, dispatch(first)), ['ack']);
  await assertSent(h, first);
  assert.deepEqual((await quotaCharges(h)).map(({ sendId, day, charges }) => ({ sendId, day, charges })),
    [{ sendId: first, day: quotaDay(h.startedAt), charges: 1 }], 'mail-send wrote to the same account object as mail-backend');
  const reset = await h.quota<number>('resetAt');
  const delayed = await queued(h, 'real-quota-delayed');
  const blockedToday = [delayed, await queued(h, 'real-quota-also-delayed')];
  const firstRefusedAt = await h.sends.now();
  for (const id of blockedToday) {
    assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
    const state = await h.sendState(id);
    assert.equal(state.row?.state, 'delayed');
    assert.equal(state.dispatch?.delayed_until, reset + 30_000);
    assert.deepEqual(state.ledger.map(row => row.state), ['pending']);
    await h.quota('runAlarm');
  }
  const alerts = () => h.alerts.filter(({ body }) => (JSON.parse(body) as { source: string }).source === `mail:${gateCode}`);
  const expectedAlert = (day: string, time: number) => ({ source: `mail:${gateCode}`, key: `send_quota_gate:test:${day}`,
    title: 'A mail account quota gate was reached', environment: 'test', time });
  const today = expectedAlert(quotaDay(h.startedAt), firstRefusedAt);
  assert.deepEqual(alerts().map(({ body }) => JSON.parse(body)), [today]);
  assert.ok(isSendEventCode(gateCode), 'the quota code is on the operator allow-list');
  assert.equal(h.providerCalls(), 1);
  await advanceTo(h, reset + 30_000);
  assert.deepEqual(await h.batch(SEND, dispatch(delayed)), ['ack']);
  await assertSent(h, delayed);
  const blockedNextDay = await queued(h, 'real-quota-new-day');
  const tomorrow = expectedAlert(quotaDay(h.startedAt, 1), await h.sends.now());
  assert.deepEqual(await h.batch(SEND, dispatch(blockedNextDay)), ['ack']);
  assert.equal((await h.sendState(blockedNextDay)).row?.state, 'delayed');
  await h.quota('runAlarm');
  await h.quota('runAlarm');
  assert.deepEqual(alerts().map(({ body }) => JSON.parse(body)), [today, tomorrow]);
  assert.deepEqual(alerts().map(({ key }) => key), [today.key, tomorrow.key]);
  assert.equal(h.providerCalls(), 2);
  assertRedacted(h);
}, { realQuota: { daily: '2' } }));

test('cross-worker three-day real quota outage keeps recipients pending, alerts at 24 hours and recovers', () => run(async h => {
  const id = await queued(h, 'quota-unavailable-three-days');
  const released = await h.sends.now();
  await h.quota('setUnavailableUntil', released + 72 * HOUR);
  const stallCount = () => sources(h).filter(source => source === stalledSource).length;
  for (let hour = 0; hour < 72; hour++) {
    await advanceTo(h, released + hour * HOUR);
    assert.deepEqual(await h.batch(SEND, dispatch(id)), ['ack']);
    const state = await h.sendState(id);
    assert.ok(state.row?.state === 'queued' || state.row?.state === 'sending', `send state at outage hour ${hour}: ${state.row?.state}`);
    assert.deepEqual(state.ledger.map(row => row.state), ['pending']);
    assert.equal(state.dispatch?.provider_wait, 0);
    assert.equal(state.dispatch?.unfinished, 0);
    await h.backendCron();
    if (hour === 23) {
      await advanceTo(h, released + 24 * HOUR - 1);
      await h.backendCron();
      assert.equal(stallCount(), 0, 'no stall alert before 24 hours since published release');
    }
    if (hour === 24) assert.equal(stallCount(), 1, 'the operator received send_stalled at 24 hours');
  }
  assert.equal(h.providerCalls(), 0);
  assert.deepEqual(await quotaCharges(h), []);
  await h.sends.driveIdle();
  const beforeRecovery = (await h.sends.queue()).length;
  await advanceTo(h, released + 72 * HOUR);
  await h.sends.driveIdle();
  const redrive = (await h.sends.queue()).slice(beforeRecovery).find(message => message.sendId === id);
  assert.deepEqual(redrive, dispatch(id), 'the mailbox published a fresh dispatch after recovery');
  assert.deepEqual(await h.batch(SEND, redrive), ['ack']);
  await assertSent(h, id);
  assert.equal(h.providerCalls(), 1);
  assert.deepEqual((await quotaCharges(h)).map(({ sendId, charges }) => ({ sendId, charges })), [{ sendId: id, charges: 1 }]);
  assertRedacted(h);
}, { realQuota: {} }));
