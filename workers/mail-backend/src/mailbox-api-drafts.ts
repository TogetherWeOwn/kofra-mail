import { hasHeaderControl, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { AddressInput, Draft, DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import { sha256 } from './bytes.ts';
import { attachmentRow, displayOf, messageRow, partNumber } from './mailbox-api-messages.ts';
import { fail, invalid, isId, iso, need, object, requireId, text, utf8 } from './mailbox-api-input.ts';
import type { ApiDraftRef, MailboxIndex } from './mailbox-index.ts';
import { parseMail } from './parse-mail.ts';

export type DraftObjectRef = Omit<ApiDraftRef, 'holder'>;
export type DraftObject = { version: 1; fields: Omit<DraftInput, 'attachments'>; replyHeaders?: ThreadingHeaders };
// A one-byte body control can escape to six JSON bytes. Include the bounded
// address/header/metadata envelope in the same limit on both reads and writes.
const MAX_DRAFT_OBJECT_BYTES = 6 * LIMITS.bodyBytes + 512 * 1024;
export function encodeDraftObject(draft: DraftObject): Uint8Array<ArrayBuffer> {
  const bytes = utf8(JSON.stringify(draft));
  if (bytes.byteLength > MAX_DRAFT_OBJECT_BYTES) return fail('payload_too_large', { limit: MAX_DRAFT_OBJECT_BYTES });
  return bytes;
}
const select = `SELECT d.id, d.raw_key AS rawKey, d.holder, a.updated_at AS updatedAt, a.revision
  FROM mailbox_api_drafts a JOIN drafts d ON d.id = a.id`;

export function draftRef(sql: SqlStorage, id: string | undefined): ApiDraftRef | undefined {
  if (isId(id)) return sql.exec<ApiDraftRef>(`${select} WHERE a.id = ?`, id).toArray()[0];
}
export function draftRefs(sql: SqlStorage, limit: number, position?: [number, string]): ApiDraftRef[] {
  const range = (where: string, values: SqlStorageValue[], count: number) => sql.exec<ApiDraftRef>(
    `${select} ${where} ORDER BY a.updated_at DESC, a.id ASC LIMIT ?`, ...values, count).toArray();
  if (!position) return range('', [], limit);
  // For a mixed sort direction, seek separately within the timestamp tie and
  // then through older timestamps, so neither query starts at the table head.
  const ties = range('WHERE a.updated_at = ? AND a.id > ?', position, limit);
  return ties.length === limit ? ties : [...ties, ...range('WHERE a.updated_at < ?', [position[0]], limit - ties.length)];
}

async function loadDraft(index: MailboxIndex, ref: DraftObjectRef): Promise<{ draft: DraftObject; bytes: number }> {
  if (!/^drafts\/[0-9a-f]{64}$/.test(ref.rawKey)) throw new Error('Invalid API draft reference');
  const bytes = await index.readObject(ref.rawKey);
  if (bytes.byteLength > MAX_DRAFT_OBJECT_BYTES || await sha256(bytes) !== ref.rawKey.slice('drafts/'.length)) {
    throw new Error('Invalid API draft object');
  }
  const draft = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as DraftObject;
  if (draft.version !== 1 || !draft.fields || typeof draft.fields !== 'object') throw new Error('Unsupported draft object');
  return { draft, bytes: bytes.byteLength };
}
export async function readDraftObject(index: MailboxIndex, ref: DraftObjectRef): Promise<DraftObject> {
  return (await loadDraft(index, ref)).draft;
}
export async function readDraftPage(index: MailboxIndex, refs: ApiDraftRef[], limit: number) {
  const items: Draft[] = [];
  // A valid draft can expand to ~6 MiB in JSON. Return fewer rows, with a
  // continuation cursor, rather than buffering a page of huge wire objects.
  const budget = 8 * 1024 * 1024;
  let bytes = 0;
  for (const ref of refs.slice(0, limit)) {
    const loaded = await loadDraft(index, ref);
    bytes += loaded.bytes + 256; // Include wire id, revision, timestamp and punctuation overhead.
    if (items.length && bytes > budget) break;
    items.push(wireDraft(ref, loaded.draft));
  }
  return { items, last: refs[items.length - 1], more: refs.length > items.length };
}
export function wireDraft(ref: DraftObjectRef, draft: DraftObject): Draft {
  return { ...draft.fields, id: ref.id, revision: ref.revision, updatedAt: iso(ref.updatedAt), attachments: [] };
}
export async function readDraft(index: MailboxIndex, ref: DraftObjectRef): Promise<Draft> {
  return wireDraft(ref, await readDraftObject(index, ref));
}

export function sender(value: unknown, canSendAs: readonly string[]): string {
  if (typeof value !== 'string' || value.length > LIMITS.addressBytes) return fail('invalid_sender');
  return canSendAs.find(email => email.toLowerCase() === value.toLowerCase()) ?? fail('invalid_sender');
}

export async function draftInput(sql: SqlStorage, index: MailboxIndex, input: unknown, canSendAs: string[], now: number,
  previous?: DraftObject): Promise<DraftObject> {
  const args = object(input, ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'inReplyTo', 'forwardOf', 'attachments']);
  if (typeof args.from === 'string' && hasHeaderControl(args.from)) fail('invalid_header', { errors: [{ field: '/from', code: 'invalid' }] });
  const from = sender(args.from, canSendAs);
  const { to: rawTo, cc: rawCc, bcc: rawBcc, attachments } = args;
  if (!Array.isArray(rawTo)) return invalid('/to');
  if (!Array.isArray(rawCc)) return invalid('/cc');
  if (!Array.isArray(rawBcc)) return invalid('/bcc');
  if (!Array.isArray(attachments)) return invalid('/attachments');
  if (rawTo.length + rawCc.length + rawBcc.length > LIMITS.recipientsPerMessage) {
    return fail('too_many_recipients', { limit: LIMITS.recipientsPerMessage });
  }
  if (attachments.filter(value => value?.kind !== 'link').length > LIMITS.attachmentsPerMessage) {
    return fail('too_many_attachments', { limit: LIMITS.attachmentsPerMessage });
  }
  // Link attachments do not consume send attachment slots; they still have a
  // bounded validation cost on this surface, which refuses them in M2-W.
  if (attachments.length > LIMITS.pageSizeMax) return invalid('/attachments', 'too_many');
  const subject = text(args.subject, LIMITS.subjectBytes, '/subject', true);
  const body = text(args.body, LIMITS.bodyBytes, '/body');
  const addresses = (list: unknown[], field: string): AddressInput[] => list.map((value, i) => {
    const path = `/${field}/${i}`;
    const addr = object(value, ['email', 'name'], path);
    return { email: text(addr.email, LIMITS.addressBytes, `${path}/email`, true),
      ...(addr.name !== undefined && { name: text(addr.name, LIMITS.displayNameBytes, `${path}/name`, true) }) };
  });
  const to = addresses(rawTo, 'to'), cc = addresses(rawCc, 'cc'), bcc = addresses(rawBcc, 'bcc');
  const inReplyTo = args.inReplyTo === undefined ? undefined : need(isId(args.inReplyTo) ? args.inReplyTo : undefined);
  const forwardOf = args.forwardOf === undefined ? undefined : need(isId(args.forwardOf) ? args.forwardOf : undefined);
  const parent = inReplyTo !== undefined && inReplyTo !== previous?.fields.inReplyTo ? messageRow(sql, inReplyTo, now) : undefined;
  if (forwardOf !== undefined && forwardOf !== previous?.fields.forwardOf) messageRow(sql, forwardOf, now);
  for (const [i, value] of attachments.entries()) {
    const path = `/attachments/${i}`;
    // Dispatch by kind first, but still reject unknown fields for each variant.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
    switch (value.kind) {
      case 'upload': {
        const ref = object(value, ['kind', 'uploadId'], path);
        requireId(ref.uploadId, `${path}/uploadId`);
        break;
      }
      case 'message': {
        const ref = object(value, ['kind', 'messageId', 'part'], path);
        const messageId = requireId(ref.messageId, `${path}/messageId`);
        if (typeof ref.part !== 'number') return invalid(`${path}/part`);
        attachmentRow(sql, messageRow(sql, messageId, now), partNumber(ref.part, `${path}/part`));
        break;
      }
      case 'link': {
        const ref = object(value, ['kind', 'url', 'name'], path);
        const urlText = text(ref.url, LIMITS.linkUrlBytes, `${path}/url`);
        const name = text(ref.name, LIMITS.linkNameBytes, `${path}/name`);
        const url = /\p{Cc}/u.test(urlText) ? null : URL.parse(urlText);
        if (url?.protocol !== 'https:' || url.username || url.password) return invalid(`${path}/url`);
        if (/\p{Cc}/u.test(name)) return invalid(`${path}/name`);
        break;
      }
      default: return invalid(`${path}/kind`);
    }
  }
  if (attachments.length) return fail('not_implemented');
  const replyHeaders = parent ? (displayOf(parent) ?? (await parseMail(await index.readObject(parent.raw_key), parent.raw_key, true)).display)?.replyHeaders :
    (inReplyTo === undefined ? undefined : previous?.replyHeaders);
  return { version: 1, fields: { from, to, cc, bcc, subject, body,
    ...(inReplyTo !== undefined && { inReplyTo }), ...(forwardOf !== undefined && { forwardOf }) }, ...(replyHeaders && { replyHeaders }) };
}
