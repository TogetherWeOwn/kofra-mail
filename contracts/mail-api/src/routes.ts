import type { Operation } from './service.ts';

/** All routes are under this prefix on the mail app host. Same origin only: no CORS. */
export const API_PREFIX = '/api/v1';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `{name}` segments are path parameters, percent-encoded. */
  path: string;
  /** Status of a successful response. */
  success: 200 | 201 | 202 | 204;
  /** `required`: a missing `Idempotency-Key` answers 428 `precondition_required`. */
  idempotency: 'required' | 'none';
  /** `required`: a missing `If-Match` answers 428; a stale one answers 412 `revision_mismatch`. */
  ifMatch: 'required' | 'optional' | 'none';
  /** `admin` needs `workspace.role === 'admin'`. */
  access: 'member' | 'admin';
  /** Needs `authTime` at most 10 minutes old, otherwise 403 `reauth_required`. */
  reauth: boolean;
  /** Request body: JSON, raw bytes (uploads) or none. GET and DELETE never have a body. */
  body: 'json' | 'bytes' | 'none';
  /** Query parameters accepted; any other parameter answers 400 `unknown_field`. */
  query: readonly string[];
  /**
   * The response body carries the mailbox `state` it was read or written at,
   * as a top-level `state` field. No other response carries one (a `Send`'s
   * own `state` is its send state); clients learn later states from the
   * live-update push.
   */
  state: boolean;
}

type R = Omit<RouteSpec, 'idempotency' | 'ifMatch' | 'access' | 'reauth' | 'body' | 'query' | 'state'> & Partial<RouteSpec>;
const route = (r: R): RouteSpec => ({ idempotency: 'none', ifMatch: 'none', access: 'member', reauth: false, body: r.method === 'GET' || r.method === 'DELETE' ? 'none' : 'json', query: [], state: false, ...r });
const paged = ['cursor', 'limit'] as const;

export const ROUTES = {
  getSession: route({ method: 'GET', path: '/session', success: 200, state: true }),

  listViews: route({ method: 'GET', path: '/views', success: 200, state: true }),
  listThreads: route({ method: 'GET', path: '/threads', success: 200, query: ['view', 'labelId', 'q', 'tz', ...paged], state: true }),
  getThread: route({ method: 'GET', path: '/threads/{threadId}', success: 200, state: true }),
  updateThreads: route({ method: 'POST', path: '/threads/update', success: 200, state: true }),
  getBodyUrl: route({ method: 'POST', path: '/messages/{messageId}/body-url', success: 200 }),
  getAttachmentUrl: route({ method: 'POST', path: '/messages/{messageId}/attachments/{part}/url', success: 200, body: 'none' }),
  saveAttachmentToDrive: route({ method: 'POST', path: '/messages/{messageId}/attachments/{part}/save-to-drive', success: 201, idempotency: 'required', body: 'none' }),

  listLabels: route({ method: 'GET', path: '/labels', success: 200, state: true }),
  createLabel: route({ method: 'POST', path: '/labels', success: 201, idempotency: 'required' }),
  renameLabel: route({ method: 'PATCH', path: '/labels/{labelId}', success: 200 }),
  deleteLabel: route({ method: 'DELETE', path: '/labels/{labelId}', success: 204 }),

  listIdentities: route({ method: 'GET', path: '/identities', success: 200 }),
  getSettings: route({ method: 'GET', path: '/settings', success: 200 }),
  updateSettings: route({ method: 'PATCH', path: '/settings', success: 200 }),

  listDrafts: route({ method: 'GET', path: '/drafts', success: 200, query: paged, state: true }),
  getDraft: route({ method: 'GET', path: '/drafts/{draftId}', success: 200 }),
  createDraft: route({ method: 'POST', path: '/drafts', success: 201, idempotency: 'required' }),
  replaceDraft: route({ method: 'PUT', path: '/drafts/{draftId}', success: 200, ifMatch: 'required' }),
  deleteDraft: route({ method: 'DELETE', path: '/drafts/{draftId}', success: 204, ifMatch: 'optional' }),
  sendDraft: route({ method: 'POST', path: '/drafts/{draftId}/send', success: 202, idempotency: 'required', ifMatch: 'required', body: 'none' }),
  listSends: route({ method: 'GET', path: '/sends', success: 200, query: ['active', ...paged], state: true }),
  getSend: route({ method: 'GET', path: '/sends/{sendId}', success: 200 }),
  undoSend: route({ method: 'POST', path: '/sends/{sendId}/undo', success: 200, idempotency: 'required', body: 'none' }),

  createUpload: route({ method: 'POST', path: '/uploads', success: 201, idempotency: 'required', body: 'bytes', query: ['name'] }),
  deleteUpload: route({ method: 'DELETE', path: '/uploads/{uploadId}', success: 204 }),
  importFromDrive: route({ method: 'POST', path: '/drive/imports', success: 201, idempotency: 'required' }),

  listDomains: route({ method: 'GET', path: '/admin/domains', success: 200, access: 'admin' }),
  addDomain: route({ method: 'POST', path: '/admin/domains', success: 201, idempotency: 'required', access: 'admin', reauth: true }),
  listMailboxes: route({ method: 'GET', path: '/admin/mailboxes', success: 200, access: 'admin', query: paged }),
  createMailbox: route({ method: 'POST', path: '/admin/mailboxes', success: 201, idempotency: 'required', access: 'admin', reauth: true }),
  updateMailbox: route({ method: 'PATCH', path: '/admin/mailboxes/{mailboxId}', success: 200, access: 'admin', reauth: true }),
  createAlias: route({ method: 'POST', path: '/admin/aliases', success: 201, idempotency: 'required', access: 'admin', reauth: true }),
  deleteAlias: route({ method: 'DELETE', path: '/admin/aliases/{address}', success: 204, access: 'admin', reauth: true }),
  listMembers: route({ method: 'GET', path: '/admin/members', success: 200, access: 'admin', query: paged }),
  listLinkLocations: route({ method: 'GET', path: '/admin/link-locations', success: 200, access: 'admin' }),
  createLinkLocation: route({ method: 'POST', path: '/admin/link-locations', success: 201, idempotency: 'required', access: 'admin', reauth: true }),
  rotateLinkLocationCredentials: route({ method: 'PUT', path: '/admin/link-locations/{locationId}/credentials', success: 200, access: 'admin', reauth: true }),
  deleteLinkLocation: route({ method: 'DELETE', path: '/admin/link-locations/{locationId}', success: 204, access: 'admin', reauth: true }),
} as const satisfies Record<Operation, RouteSpec>;

/** Path parameters of a route, in order. */
export function pathParams(spec: Pick<RouteSpec, 'path'>): string[] {
  return Array.from(spec.path.matchAll(/\{([A-Za-z]+)\}/g), (m) => m[1]);
}
