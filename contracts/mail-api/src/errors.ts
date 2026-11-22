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
  no_html_body: 404,
  label_exists: 409,
  address_taken: 409,
  domain_exists: 409,
  send_not_pending: 409,
  idempotency_in_progress: 409,
  revision_mismatch: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  invalid_sender: 422,
  invalid_recipients: 422,
  too_many_recipients: 422,
  too_many_attachments: 422,
  message_too_large: 422,
  limit_reached: 422,
  domain_not_in_workspace: 422,
  precondition_required: 428,
  rate_limited: 429,
  internal: 500,
  feature_unavailable: 501,
  mailbox_restoring: 503,
  unavailable: 503,
} as const;

export type MailErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as MailErrorCode[];

/** A field-level problem inside `invalid_request`; `field` is a JSON Pointer into the request body. */
export interface FieldError {
  field: string;
  code: 'required' | 'invalid' | 'too_long' | 'too_many' | 'not_allowed';
}

export interface Problem {
  /** `https://kofra.app/docs/errors/<code>`; clients switch on `code`, never on `type` or `title`. */
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
  /** Mirrors `Retry-After` for 429 and 503. */
  retryAfterSeconds?: number;
  /** For `reauth_required`: the `max_age` the client sends to the account service. */
  maxAgeSeconds?: number;
}

export function problem(code: MailErrorCode, extra: Omit<Partial<Problem>, 'code' | 'status' | 'type'> = {}): Problem {
  return {
    type: `https://kofra.app/docs/errors/${code}`,
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
