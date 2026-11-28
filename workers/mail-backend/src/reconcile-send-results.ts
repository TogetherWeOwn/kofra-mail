import { NOTICE_BACKOFF_MAX_MS, NOTICE_BACKOFF_MS, RESTORING_NOTICE_MS } from './send-result-backoff.ts';
import type { ResultNotice } from './send-consumer.ts';

const PAGE = 128; // Includes an entire 100-row restoring prefix without starving the next mailbox.
const BATCH = 100; // Queues limit per sendBatch call.

// Reserve the bounded page before enqueuing. Materializing the indexed, ordered
// seek keeps the page fixed while the UPDATE moves rows forward in that index.
// This advances the schedule even if the Worker dies or a notice is dropped.
export const TAKE_SEND_NOTICES = `WITH due AS MATERIALIZED (
  SELECT workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt
  FROM send_results INDEXED BY send_results_notify
  WHERE notify_after <= ?
  ORDER BY notify_after, workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt
  LIMIT ?
)
UPDATE send_results
SET notify_after = ? + max(?, min(?, ? * (1 << min(notify_failures, 16))))
WHERE (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt)
  IN (SELECT workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt FROM due)
RETURNING workspace_id AS ws, mailbox_id AS mb, send_id AS sendId, fence_epoch AS epoch, fence_attempt AS attempt`;

type NoticeRow = { ws: string; mb: string; sendId: string; epoch: number; attempt: number };

export type NoticeBatchProducer = { sendBatch(messages: Iterable<MessageSendRequest<ResultNotice>>): Promise<unknown> };

export async function reconcileSendResults(db: D1Database, queue: NoticeBatchProducer, now: number): Promise<void> {
  const { results } = await db.withSession('first-primary').prepare(TAKE_SEND_NOTICES)
    .bind(now, PAGE, now, RESTORING_NOTICE_MS, NOTICE_BACKOFF_MAX_MS, NOTICE_BACKOFF_MS).all<NoticeRow>();
  for (let offset = 0; offset < results.length; offset += BATCH) {
    try {
      await queue.sendBatch(results.slice(offset, offset + BATCH).map(({ ws, mb, sendId, epoch, attempt }) => ({
        body: { kind: 'result', ws, mb, sendId, fence: { epoch, attempt } },
      })));
    } catch { console.error({ code: 'send_notice_batch_failed' }); }
  }
}
