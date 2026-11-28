/**
 * Error catalogue. Every failed call answers RFC 9457 `application/problem+json`
 * with one of these codes; the HTTP status is fixed per code.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unknown_field: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  reauth_required: 403,
  not_found: 404,
  label_exists: 409,
  address_taken: 409,
  domain_exists: 409,
  location_in_use: 409,
  send_not_pending: 409,
  idempotency_in_progress: 409,
  revision_mismatch: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  invalid_sender: 422,
  invalid_recipients: 422,
  invalid_header: 422,
  too_many_recipients: 422,
  too_many_attachments: 422,
  message_too_large: 422,
  limit_reached: 422,
  domain_not_in_workspace: 422,
  storage_check_failed: 422,
  precondition_required: 428,
  rate_limited: 429,
  internal: 500,
  feature_unavailable: 501,
  not_implemented: 501,
  mailbox_restoring: 503,
  unavailable: 503,
} as const;

export type MailErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as MailErrorCode[];

/**
 * Why a link storage location failed its save check (`storage_check_failed`):
 * - `endpoint`: not `https:` on port 443, an IP literal, or a refused host;
 * - `redirect`: the endpoint answered a 3xx, which is never followed;
 * - `public_bucket`: an anonymous read or list of the probe object was not refused;
 * - `read_key_writable`: the read-only key is the write key, or may write or delete;
 * - `auth`: a key was refused for an object or bucket operation it needs;
 * - `bucket`: the bucket is missing or answered unexpectedly;
 * - `multipart`: a multipart operation (create, part, list parts, complete, abort) failed;
 * - `network`: the endpoint could not be reached in time.
 */
export const STORAGE_CHECK_REASONS = ['endpoint', 'redirect', 'public_bucket', 'read_key_writable', 'auth', 'bucket', 'multipart', 'network'] as const;
export type StorageCheckReason = (typeof STORAGE_CHECK_REASONS)[number];

/** A field-level problem inside `invalid_request` or `invalid_header`; `field` is a JSON Pointer into the request body. */
export interface FieldError {
  field: string;
  code: 'required' | 'invalid' | 'too_long' | 'too_many' | 'not_allowed';
}

/**
 * The default problem `type` prefix: a stable, non-dereferenceable URI, so a
 * fake, a local backend and every deployment emit the same type without
 * naming a real host. A deployment that publishes error pages passes its own
 * documentation base to `problem` instead.
 */
export const PROBLEM_TYPE_PREFIX = 'urn:kofra-mail:problem:';

export interface Problem {
  /** `<prefix><code>`, by default `urn:kofra-mail:problem:<code>`; clients switch on `code`, never on `type` or `title`. */
  type: string;
  title: string;
  status: number;
  code: MailErrorCode;
  /** Human-readable; never contains message content, addresses of other mailboxes or secrets. */
  detail?: string;
  requestId?: string;
  errors?: FieldError[];
  /** The limit that was exceeded, for `payload_too_large`, `message_too_large`, `too_many_*` and `limit_reached`. */
  limit?: number;
  /** Mirrors `Retry-After` for 429, 503 and 409 `idempotency_in_progress`. */
  retryAfterSeconds?: number;
  /** For `reauth_required`: the `max_age` the client sends to the account service. */
  maxAgeSeconds?: number;
  /** For `storage_check_failed`: the fixed reason. Never a provider message, status or header. */
  reason?: StorageCheckReason;
}

/** `typePrefix` is `PROBLEM_TYPE_PREFIX` or a deployment-configured documentation base ending in `/`. */
export function problem(
  code: MailErrorCode, extra: Omit<Partial<Problem>, 'code' | 'status' | 'type'> = {}, typePrefix: string = PROBLEM_TYPE_PREFIX,
): Problem {
  return {
    type: `${typePrefix}${code}`,
    title: extra.title ?? code.replaceAll('_', ' '),
    status: ERROR_STATUS[code],
    code,
    ...extra,
  };
}

/** Thrown by every `MailService` implementation, and by the HTTP client for a problem response. */
export class MailApiError extends Error {
  readonly problem: Problem;
  constructor(value: Problem) {
    super(value.detail ?? value.title);
    this.name = 'MailApiError';
    this.problem = value;
  }
  get code(): MailErrorCode { return this.problem.code; }
  get status(): number { return this.problem.status; }
}

export function isMailApiError(value: unknown, code?: MailErrorCode): value is MailApiError {
  return value instanceof MailApiError && (code === undefined || value.problem.code === code);
}
