const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Limits every implementation enforces and reports in `Session.limits`.
 * Clients read the served values; they never hard-code them, because
 * `outboundMessageBytes` changes once the outbound size test has run.
 */
export interface Limits {
  /** Largest inbound message the platform accepts; larger mail is rejected before our code runs. */
  inboundMessageBytes: number;
  /** Largest encoded outbound message (headers, body and base64 attachments). */
  outboundMessageBytes: number;
  /** To + Cc + Bcc of one message. */
  recipientsPerMessage: number;
  /** File attachments of one outbound message; link attachments do not count. */
  attachmentsPerMessage: number;
  /** One uploaded file. */
  uploadBytes: number;
  /**
   * UTF-8 bytes of one provider custom header value (In-Reply-To, References),
   * unfolded. `threadingHeaders` trims References to it.
   */
  headerValueBytes: number;
  /** UTF-8 bytes of a subject. */
  subjectBytes: number;
  /** UTF-8 bytes of a draft body. */
  bodyBytes: number;
  /** UTF-8 bytes of the signature setting. */
  signatureBytes: number;
  /** UTF-8 bytes of a display name. */
  displayNameBytes: number;
  /** UTF-8 bytes of one address in a draft (RFC 5321's 254 for a path). */
  addressBytes: number;
  /** UTF-8 bytes of a link attachment's URL and of its name. */
  linkUrlBytes: number;
  linkNameBytes: number;
  /** Characters (code points) of a label name, after trimming. */
  labelNameChars: number;
  labelsPerMessage: number;
  labelsPerMailbox: number;
  aliasesPerMailbox: number;
  /** A new thread starts after this many messages. */
  threadMessages: number;
  pageSizeDefault: number;
  pageSizeMax: number;
  /** Thread ids in one `updateThreads` call. */
  batchThreads: number;
  /** UTF-8 bytes of a search query. */
  queryBytes: number;
  /** Leading UTF-8 bytes of each body that search indexes. */
  searchBodyBytes: number;
  /** Plain text per message in a conversation response; longer text sets `textTruncated`. */
  messageTextBytes: number;
  idempotencyKeyChars: number;
  idempotencyRetentionSeconds: number;
  /** Lifetime of an unattached upload. */
  uploadRetentionSeconds: number;
  /** Lifetime of a signed content URL (bodies, attachments, images). */
  contentUrlSeconds: number;
  /** Largest remote image the image proxy returns. */
  remoteImageBytes: number;
  remoteImageRedirects: number;
  /** Days a message stays in Spam or Trash before it expires. */
  spamTrashRetentionDays: number;
  undoSecondsOptions: readonly number[];
}

/**
 * Contract values. Sources: Cloudflare Email Service limits (inbound 25 MiB,
 * 50 recipients, 32 attachments, 2,048-byte header values), Durable Object
 * threading rule (100 messages), and this contract's own bounds.
 *
 * `outboundMessageBytes` is 5 MiB, the lower of the two documented values,
 * until the outbound size test measures the real limit. A backend raises it
 * only from that measurement.
 */
export const LIMITS = {
  inboundMessageBytes: 25 * MiB,
  outboundMessageBytes: 5 * MiB,
  recipientsPerMessage: 50,
  attachmentsPerMessage: 32,
  uploadBytes: 25 * MiB,
  headerValueBytes: 2048,
  subjectBytes: 998,
  bodyBytes: 1 * MiB,
  signatureBytes: 10 * KiB,
  displayNameBytes: 256,
  addressBytes: 254,
  linkUrlBytes: 2048,
  linkNameBytes: 255,
  labelNameChars: 72,
  labelsPerMessage: 64,
  labelsPerMailbox: 1000,
  aliasesPerMailbox: 30,
  threadMessages: 100,
  pageSizeDefault: 50,
  pageSizeMax: 100,
  batchThreads: 100,
  queryBytes: 512,
  searchBodyBytes: 64 * KiB,
  messageTextBytes: 64 * KiB,
  idempotencyKeyChars: 64,
  idempotencyRetentionSeconds: 24 * 60 * 60,
  uploadRetentionSeconds: 24 * 60 * 60,
  contentUrlSeconds: 300,
  remoteImageBytes: 5 * MiB,
  remoteImageRedirects: 3,
  spamTrashRetentionDays: 30,
  undoSecondsOptions: [5, 10, 20, 30],
} as const satisfies Limits;

/**
 * A conservative estimate of the raw attachment bytes that fit in one
 * outbound message with `bodyBytes` of UTF-8 body text. Base64 grows bytes by
 * 4/3 and MIME adds CRLF after every 76 encoded characters (78/76); the body
 * is counted at the same rate (the backend never encodes it larger than
 * base64), and 16 KiB is reserved for headers and MIME structure. Files within
 * the budget pass unless the headers are unusually large; files above it may
 * still pass. The server's check at send time is authoritative.
 */
export function attachmentBudget(limits: Pick<Limits, 'outboundMessageBytes'>, bodyBytes: number): number {
  const encoded = (raw: number) => Math.ceil((raw * 4 * 78) / (3 * 76));
  return Math.max(0, Math.floor(((limits.outboundMessageBytes - encoded(bodyBytes) - 16 * KiB) * 3 * 76) / (4 * 78)));
}
