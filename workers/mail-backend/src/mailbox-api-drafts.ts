import { hasHeaderControl, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { isLinkExpiry, LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { AddressInput, Draft, DraftAttachment, DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import { sha256 } from './bytes.ts';
import { attachmentRow, displayOf, messageRow, partNumber } from './mailbox-api-messages.ts';
import { fail, invalid, isId, iso, need, object, requireId, text, utf8 } from './mailbox-api-input.ts';
import type { ApiDraftRef, MailboxIndex } from './mailbox-index.ts';
import { decodedAttachment, MAX_INDEXED_ATTACHMENTS, parseMail, readMailMime } from './parse-mail.ts';
import { unusableSource, uploadReferenced, uploadRow } from './mailbox-upload.ts';
import { ObjectInvalidError } from './object-errors.ts';
import { draftLinkExpiry, isLinkFileName, isStoredFileLink, type StoredFileLink } from './file-links.ts';
import { parseObjectKey } from './object-key.ts';

export type DraftObjectRef = Omit<ApiDraftRef, 'holder'>;
// A small forwarded part is read from its source raw message; `part` records the
// decoded bytes' digest and size when it is attached, so release can verify them.
export type PartFingerprint = { digest: string; size: number };
type StoredAttachment =
  | { wire: Extract<DraftAttachment, { kind: 'link' }> }
  // A file link (M3-13): a completed link upload's object, sent as a download link.
  | { wire: Extract<DraftAttachment, { kind: 'file_link' }>; link: StoredFileLink }
  | { wire: Exclude<DraftAttachment, { kind: 'link' | 'file_link' }>; key: string; part?: PartFingerprint };
export type DraftObject = { version: 1; fields: Omit<DraftInput, 'attachments'>;
  attachments?: StoredAttachment[]; replyHeaders?: ThreadingHeaders };

export function draftObjectKeys(draft: DraftObject): string[] {
  return [...new Set((draft.attachments ?? []).flatMap(attachment => 'key' in attachment ? [attachment.key] : []))];
}

export function draftUploadIds(draft: DraftObject): string[] {
  return [...new Set((draft.attachments ?? []).flatMap(({ wire }) => wire.kind === 'upload' ? [wire.uploadId] : []))];
}
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
    `${select} WHERE NOT EXISTS (SELECT 1 FROM mailbox_unusable_sources u WHERE u.kind = 'draft' AND u.id = a.id)
      ${where} ORDER BY a.updated_at DESC, a.id ASC LIMIT ?`, ...values, count).toArray();
  if (!position) return range('', [], limit);
  // For a mixed sort direction, seek separately within the timestamp tie and
  // then through older timestamps, so neither query starts at the table head.
  const ties = range('AND a.updated_at = ? AND a.id > ?', position, limit);
  return ties.length === limit ? ties : [...ties, ...range('AND a.updated_at < ?', [position[0]], limit - ties.length)];
}

async function loadDraft(index: MailboxIndex, ref: DraftObjectRef): Promise<{ draft: DraftObject; bytes: number }> {
  const parsed = parseObjectKey(ref.rawKey);
  const digest = parsed?.kind === 'raw' ? parsed.digest : /^drafts\/([0-9a-f]{64})$/.exec(ref.rawKey)?.[1];
  if (!digest) throw new Error('Invalid API draft reference');
  const bytes = await index.readObject(ref.rawKey);
  // The read enforced the declared length, so wrong bytes are corrupt for good.
  if (bytes.byteLength > MAX_DRAFT_OBJECT_BYTES || await sha256(bytes) !== digest) {
    throw new ObjectInvalidError('Invalid API draft object');
  }
  // The bytes match their content address, so if they do not decode to a
  // draft object, no retry can change that.
  let draft: DraftObject;
  try { draft = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as DraftObject; }
  catch { throw new ObjectInvalidError('Invalid API draft object'); }
  if (!isRecord(draft) || draft.version !== 1 || !isRecord(draft.fields)) throw new ObjectInvalidError('Unsupported draft object');
  return { draft, bytes: bytes.byteLength };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
// A string within `max` UTF-8 bytes, the bound the draft save path applies.
const isBounded = (value: unknown, max: number, header = false) =>
  isText(value) && utf8(value).byteLength <= max && !(header && hasHeaderControl(value));
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isAddress = (value: unknown) => isRecord(value) && isBounded(value.email, LIMITS.addressBytes, true) &&
  optional(value.name, name => isBounded(name, LIMITS.displayNameBytes, true));
function isStoredAttachment(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.wire) || !isText(value.wire.name)) return false;
  const { wire } = value;
  if (wire.kind === 'link') return isBounded(wire.url, LIMITS.linkUrlBytes) && isBounded(wire.name, LIMITS.linkNameBytes);
  if (wire.kind === 'file_link') {
    return isId(wire.linkUploadId) && isLinkFileName(wire.name) && isCount(wire.size) && isLinkExpiry(wire.expiry) && isStoredFileLink(value.link);
  }
  // An upload is an att/ object; a forwarded part is inside its raw/ source or its own att/ object.
  const kind = isText(value.key) ? parseObjectKey(value.key)?.kind : undefined;
  return isText(wire.type) && isCount(wire.size) &&
    optional(value.part, part => isRecord(part) && isText(part.digest) && isCount(part.size)) &&
    (wire.kind === 'upload' ? kind === 'att' && isText(wire.uploadId) : wire.kind === 'message' && !!kind && isText(wire.messageId) && isCount(wire.part));
}
// Everything release reads from a decoded draft object, within the bounds the
// draft save path applies; anything else is unusable for good. The API read
// paths keep their own answers, so only release applies this check.
export function sendableDraftObject(draft: DraftObject): boolean {
  const { fields, attachments, replyHeaders } = draft as unknown as Record<string, unknown> & { fields: Record<string, unknown> };
  const lists = [fields.to, fields.cc, fields.bcc];
  return isBounded(fields.from, LIMITS.addressBytes, true) && lists.every(list => Array.isArray(list) && list.every(isAddress)) &&
    lists.reduce<number>((sum, list) => sum + (list as unknown[]).length, 0) <= LIMITS.recipientsPerMessage &&
    isBounded(fields.subject, LIMITS.subjectBytes, true) && isBounded(fields.body, LIMITS.bodyBytes) &&
    optional(fields.inReplyTo, isId) && optional(fields.forwardOf, isId) &&
    // The save path keeps at most pageSizeMax attachments, links included, and at most fileLinksPerMessage file links.
    optional(attachments, list => Array.isArray(list) && list.length <= LIMITS.pageSizeMax && list.every(isStoredAttachment) &&
      list.filter(entry => (entry as StoredAttachment).wire.kind === 'file_link').length <= LIMITS.fileLinksPerMessage) &&
    // The v1 builder leaves out unsafe threading values (cleanMimeMessageV1).
    optional(replyHeaders, headers => isRecord(headers) && optional(headers.inReplyTo, isText) && optional(headers.references, isText));
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
// Decodes small forwarded parts kept inside their source raw messages, as the
// deployed parser reads them. A source can be large, so sources are processed
// one at a time: each is read and parsed once, only the wanted parts' bytes are
// copied out, and the parse is dropped before the next source is read. `visit`
// returning false stops the walk.
export async function eachForwardedPart<T extends { key: string; part: number }>(read: (key: string) => Promise<Uint8Array<ArrayBuffer>>,
  wanted: readonly T[], visit: (item: T, bytes: Uint8Array<ArrayBuffer> | undefined) => Promise<boolean | void>): Promise<void> {
  const sources = new Map<string, T[]>();
  for (const item of wanted) sources.set(item.key, [...sources.get(item.key) ?? [], item]);
  for (const [key, items] of sources) {
    const copies = await (async () => {
      const parsed = await readMailMime(await read(key), key);
      const { length } = parsed.attachments;
      return items.map(({ part }) => {
        // As the content endpoint does: past the indexed limit, the last indexed part
        // is the synthetic "(N more attachments)" row, never a real file.
        if (length > MAX_INDEXED_ATTACHMENTS && part >= MAX_INDEXED_ATTACHMENTS) return undefined;
        const attachment = parsed.attachments[part - 1];
        return attachment && decodedAttachment(attachment.content).slice();
      });
    })();
    for (const [i, item] of items.entries()) if (await visit(item, copies[i]) === false) return;
  }
}
export const inlinePart = (key: string) => parseObjectKey(key)?.kind === 'raw';

// Fingerprints the small forwarded parts of a draft that do not carry one yet.
export async function fingerprintParts(index: MailboxIndex, attachments: StoredAttachment[]): Promise<StoredAttachment[]> {
  const result = [...attachments];
  const wanted = attachments.flatMap((attachment, at) => attachment.wire.kind === 'message' && 'key' in attachment && !attachment.part &&
    inlinePart(attachment.key) ? [{ at, key: attachment.key, part: attachment.wire.part, size: attachment.wire.size }] : []);
  await eachForwardedPart(key => index.readObject(key), wanted, async (item, bytes) => {
    // The builder lays out the indexed size. A part that decodes to another size,
    // such as a synthetic "(N more attachments)" row, cannot be sent.
    if (!bytes || bytes.byteLength !== item.size) return fail('not_found');
    result[item.at] = { ...attachments[item.at], part: { digest: await sha256(bytes), size: bytes.byteLength } } as StoredAttachment;
  });
  return result;
}

export function wireDraft(ref: DraftObjectRef, draft: DraftObject): Draft {
  return { ...draft.fields, id: ref.id, revision: ref.revision, updatedAt: iso(ref.updatedAt),
    attachments: draft.attachments?.map(({ wire }) => wire) ?? [] };
}
export async function readDraft(index: MailboxIndex, ref: DraftObjectRef): Promise<Draft> {
  return wireDraft(ref, await readDraftObject(index, ref));
}

export function sender(value: unknown, canSendAs: readonly string[]): string {
  if (typeof value !== 'string' || value.length > LIMITS.addressBytes) return fail('invalid_sender');
  return canSendAs.find(email => email.toLowerCase() === value.toLowerCase()) ?? fail('invalid_sender');
}

export async function draftInput(sql: SqlStorage, index: MailboxIndex, input: unknown, canSendAs: string[], now: number,
  previous?: DraftObject, enableAttachments = false): Promise<DraftObject> {
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
  if (attachments.filter(value => value?.kind !== 'link' && value?.kind !== 'file_link').length > LIMITS.attachmentsPerMessage) {
    return fail('too_many_attachments', { limit: LIMITS.attachmentsPerMessage });
  }
  if (attachments.filter(value => value?.kind === 'file_link').length > LIMITS.fileLinksPerMessage) return invalid('/attachments', 'too_many');
  // Link attachments do not consume send attachment slots; bound their validation cost separately.
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
  const stored: StoredAttachment[] = [];
  for (const [i, value] of attachments.entries()) {
    const path = `/attachments/${i}`;
    // Dispatch by kind first, but still reject unknown fields for each variant.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
    switch (value.kind) {
      case 'upload': {
        const ref = object(value, ['kind', 'uploadId'], path);
        const uploadId = requireId(ref.uploadId, `${path}/uploadId`);
        if (enableAttachments) {
          const upload = need(uploadRow(sql, uploadId));
          if (unusableSource(sql, 'upload', uploadId) || (upload.expiresAt <= now && !uploadReferenced(sql, uploadId))) return fail('not_found');
          stored.push({ wire: { kind: 'upload', uploadId, name: upload.name, type: upload.mediaType, size: upload.size }, key: upload.objectKey });
        }
        break;
      }
      case 'message': {
        const ref = object(value, ['kind', 'messageId', 'part'], path);
        const messageId = requireId(ref.messageId, `${path}/messageId`);
        if (typeof ref.part !== 'number') return invalid(`${path}/part`);
        const part = partNumber(ref.part, `${path}/part`);
        const carried = enableAttachments && previous?.attachments?.find(({ wire }) =>
          wire.kind === 'message' && wire.messageId === messageId && wire.part === part);
        if (carried) { stored.push(carried); break; }
        const message = messageRow(sql, messageId, now);
        const row = attachmentRow(sql, message, part);
        if (enableAttachments) stored.push({ wire: { kind: 'message', messageId, part, name: row.name, type: row.mime_type, size: row.size },
          key: row.object_key ?? message.raw_key });
        break;
      }
      case 'link': {
        const ref = object(value, ['kind', 'url', 'name'], path);
        const urlText = text(ref.url, LIMITS.linkUrlBytes, `${path}/url`);
        const name = text(ref.name, LIMITS.linkNameBytes, `${path}/name`);
        const url = /\p{Cc}/u.test(urlText) ? null : URL.parse(urlText);
        if (url?.protocol !== 'https:' || url.username || url.password) return invalid(`${path}/url`);
        if (/\p{Cc}/u.test(name)) return invalid(`${path}/name`);
        if (enableAttachments) stored.push({ wire: { kind: 'link', url: urlText, name } });
        break;
      }
      case 'file_link': {
        const ref = object(value, ['kind', 'linkUploadId', 'expiry'], path);
        const linkUploadId = requireId(ref.linkUploadId, `${path}/linkUploadId`);
        const expiry = draftLinkExpiry(ref.expiry);
        if (expiry === undefined) return invalid(`${path}/expiry`);
        if (!enableAttachments) break;
        // A file link already on the draft keeps its upload; only the expiry choice may change.
        const carried = previous?.attachments?.find(({ wire }) => wire.kind === 'file_link' && wire.linkUploadId === linkUploadId);
        if (carried && 'link' in carried && carried.wire.kind === 'file_link') {
          stored.push({ wire: { ...carried.wire, expiry }, link: carried.link });
          break;
        }
        // Link uploads (M3-15b) attach here once they exist; until then none can be found.
        return fail('not_found');
      }
      default: return invalid(`${path}/kind`);
    }
  }
  if (!enableAttachments && (attachments.length || previous?.attachments?.length)) return fail('not_implemented');
  const replyHeaders = parent ? (displayOf(parent) ?? (await parseMail(await index.readObject(parent.raw_key), parent.raw_key, true)).display)?.replyHeaders :
    (inReplyTo === undefined ? undefined : previous?.replyHeaders);
  return { version: 1, fields: { from, to, cc, bcc, subject, body,
    ...(inReplyTo !== undefined && { inReplyTo }), ...(forwardOf !== undefined && { forwardOf }) },
    ...(stored.length && { attachments: await fingerprintParts(index, stored) }), ...(replyHeaders && { replyHeaders }) };
}
