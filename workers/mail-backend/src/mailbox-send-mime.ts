// The MIME-builder port of the send path (docs/m3-outbound-plan.md, section 3,
// M3-3). Release builds the sent copy only through this port, from inputs the
// send froze at sendDraft, so a rerun builds identical bytes. The builder
// version is frozen too: a deploy that adds a version keeps the old one for
// sends that recorded it.

import { buildSentCopy, encodedSentCopySize, SEND_MIME_VERSION, type SendMimeAttachment as SendMimeBuiltAttachment } from './send-mime.ts';

export type SendMimeAddress = { email: string; name?: string };
export type SendMimeAttachment = { name: string; type: string; size: number };
export type SendMimeMessage = {
  // `<…>`, derived from the send id.
  messageId: string;
  // Derived from the send id.
  boundary: string;
  // The message's Date: the send's first undoUntil, never moved.
  date: number;
  from: SendMimeAddress;
  // Email Service accepts one Reply-To address; the send record rejects more.
  replyTo: [] | [SendMimeAddress];
  to: SendMimeAddress[];
  cc: SendMimeAddress[];
  // Validated alongside To and Cc, but never serialized in the sent copy.
  bcc: SendMimeAddress[];
  subject: string;
  text: string;
  attachments: SendMimeAttachment[];
  inReplyTo?: string;
  references?: string;
};
// Reads one attachment's bytes, in the order of `attachments`.
export type SendMimeParts = (index: number) => Promise<Uint8Array<ArrayBuffer>>;

export interface SendMimeBuilder {
  readonly version: number;
  // The exact encoded size of `build` for this message, without reading any attachment.
  encodedSize(message: SendMimeMessage): number;
  build(message: SendMimeMessage, parts: SendMimeParts): Promise<Uint8Array<ArrayBuffer>>;
}

export type SendMimeBuilders = { readonly current: number; get(version: number): SendMimeBuilder | undefined };

export function mimeBuilders(...builders: SendMimeBuilder[]): SendMimeBuilders {
  const byVersion = new Map(builders.map(builder => [builder.version, builder]));
  if (!builders.length || byVersion.size !== builders.length) throw new Error('Invalid MIME builder set');
  return { current: Math.max(...byVersion.keys()), get: version => byVersion.get(version) };
}

function inputFor(message: SendMimeMessage) {
  if (message.replyTo.length > 1) throw new Error('More than one frozen Reply-To address');
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    ...(message.replyTo[0] && { frozenReplyTo: message.replyTo[0] }),
    ...(message.inReplyTo || message.references ? { threading: { inReplyTo: message.inReplyTo, references: message.references } } : {}),
    dateAt: message.date,
    messageId: message.messageId,
    boundary: message.boundary,
    builderVersion: SEND_MIME_VERSION,
  };
}

const sentCopyMimeBuilder: SendMimeBuilder = {
  version: SEND_MIME_VERSION,
  encodedSize(message) {
    return encodedSentCopySize({ ...inputFor(message), attachments: message.attachments });
  },
  async build(message, parts) {
    const attachments: SendMimeBuiltAttachment[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
      const data = await parts(index);
      if (data.byteLength !== attachment.size) throw new Error('Send attachment size changed');
      attachments.push({ ...attachment, bytes: data });
    }
    return buildSentCopy({ ...inputFor(message), attachments }).bytes;
  },
};

export const defaultMimeBuilders = () => mimeBuilders(sentCopyMimeBuilder);
