import { ERROR_STATUS, MailApiError, isMailApiError, problem } from './errors.ts';
import type { MailErrorCode, Problem } from './errors.ts';
import { API_PREFIX, ROUTES } from './routes.ts';
import type { Conditional, Idempotent, MailService, Operation, UploadInput } from './service.ts';
import type { Session } from './wire.ts';

interface Call {
  params?: Record<string, string | number>;
  query?: object;
  json?: unknown;
  upload?: UploadInput;
  options?: Partial<Conditional & Idempotent>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProblem(value: unknown, status: number): value is Problem {
  return isObject(value) && typeof value.type === 'string' && typeof value.title === 'string'
    && typeof value.code === 'string' && Object.hasOwn(ERROR_STATUS, value.code)
    && value.status === status && ERROR_STATUS[value.code as MailErrorCode] === status;
}

function unexpected(response: Response): MailApiError {
  const requestId = response.headers.get('X-Request-Id');
  // This is synthesized locally for a non-contract response; keep the observed HTTP status.
  return new MailApiError({ ...problem('internal', { title: 'Unexpected mail API response', ...(requestId && { requestId }) }), status: response.status });
}

/** Same-origin browser adapter. The injected fetch is used by the local HTTP harness. */
export function createHttpMailService({ baseUrl = API_PREFIX, fetch: fetcher = globalThis.fetch, onProblem }: {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  onProblem?: (error: MailApiError, operation: Operation) => void;
} = {}): MailService {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  const base = baseUrl.slice(0, end);
  let csrfToken: string | undefined;
  let sessionRead: Promise<Session> | undefined;

  function getSession(): Promise<Session> {
    sessionRead ??= request('getSession').then((session) => {
      if (typeof session.csrfToken !== 'string' || !session.csrfToken) {
        csrfToken = undefined;
        throw new MailApiError(problem('internal', { title: 'Mail session is missing a CSRF token' }));
      }
      csrfToken = session.csrfToken;
      return session;
    }).finally(() => { sessionRead = undefined; });
    return sessionRead;
  }

  async function request<K extends Operation>(operation: K, call: Call = {}): Promise<Awaited<ReturnType<MailService[K]>>> {
    const route = ROUTES[operation];
    const path = route.path.replace(/\{([A-Za-z]+)\}/g, (_part, name: string) => {
      const segment = String(call.params?.[name]);
      // The URL parser normalizes dot segments even if they are percent-encoded.
      if (segment === '.' || segment === '..') throw new MailApiError(problem('invalid_request'));
      return encodeURIComponent(segment);
    });
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) query.set(name, String(value));
    }
    const search = query.size ? `?${query}` : '';
    const headers = new Headers({ Accept: 'application/json, application/problem+json' });
    const token = route.method === 'GET' ? csrfToken : (sessionRead ? (await sessionRead).csrfToken : csrfToken ?? (await getSession()).csrfToken);
    if (route.method !== 'GET' && token !== undefined) headers.set('X-CSRF-Token', token);
    if (route.idempotency === 'required' && call.options?.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', call.options.idempotencyKey);
    }
    if (route.ifMatch !== 'none' && call.options?.ifMatch !== undefined) headers.set('If-Match', call.options.ifMatch);

    let body: Blob | string | undefined;
    if (route.body === 'json') {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      body = JSON.stringify(call.json);
    } else if (route.body === 'bytes' && call.upload) {
      headers.set('Content-Type', call.upload.type || 'application/octet-stream');
      body = call.upload.bytes;
    }

    const init: RequestInit & { credentials: 'same-origin'; mode: 'same-origin' } = {
      method: route.method, headers, body,
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    };
    const response = await fetcher(`${base}${path}${search}`, init);
    if (response.status === 204 && route.success === 204) return undefined as Awaited<ReturnType<MailService[K]>>;
    if (response.status === 401 && csrfToken === token) csrfToken = undefined;
    const value: unknown = await response.json().catch(() => undefined);
    if (response.status !== route.success) {
      const error = isProblem(value, response.status) ? new MailApiError(value) : unexpected(response);
      if (isMailApiError(error, 'csrf_failed') && csrfToken === token) csrfToken = undefined;
      onProblem?.(error, operation);
      throw error;
    }
    if (!isObject(value)) throw unexpected(response);
    return value as Awaited<ReturnType<MailService[K]>>;
  }

  return {
    getSession,
    listViews: () => request('listViews'),
    listThreads: (query) => request('listThreads', { query }),
    getThread: (threadId) => request('getThread', { params: { threadId } }),
    updateThreads: (json) => request('updateThreads', { json }),
    getBodyUrl: (messageId, json) => request('getBodyUrl', { params: { messageId }, json }),
    getAttachmentUrl: (messageId, part) => request('getAttachmentUrl', { params: { messageId, part } }),
    saveAttachmentToDrive: (messageId, part, options) => request('saveAttachmentToDrive', { params: { messageId, part }, options }),
    listLabels: () => request('listLabels'),
    createLabel: (json, options) => request('createLabel', { json, options }),
    renameLabel: (labelId, json) => request('renameLabel', { params: { labelId }, json }),
    deleteLabel: (labelId) => request('deleteLabel', { params: { labelId } }),
    listIdentities: () => request('listIdentities'),
    getSettings: () => request('getSettings'),
    updateSettings: (json) => request('updateSettings', { json }),
    listDrafts: (query) => request('listDrafts', { query }),
    getDraft: (draftId) => request('getDraft', { params: { draftId } }),
    createDraft: (json, options) => request('createDraft', { json, options }),
    replaceDraft: (draftId, json, options) => request('replaceDraft', { params: { draftId }, json, options }),
    deleteDraft: (draftId, options) => request('deleteDraft', { params: { draftId }, options }),
    sendDraft: (draftId, options) => request('sendDraft', { params: { draftId }, options }),
    listSends: (query) => request('listSends', { query }),
    getSend: (sendId) => request('getSend', { params: { sendId } }),
    undoSend: (sendId, options) => request('undoSend', { params: { sendId }, options }),
    createUpload: (upload, options) => request('createUpload', { upload, query: { name: upload.name }, options }),
    deleteUpload: (uploadId) => request('deleteUpload', { params: { uploadId } }),
    importFromDrive: (json, options) => request('importFromDrive', { json, options }),
    listDomains: () => request('listDomains'),
    addDomain: (json, options) => request('addDomain', { json, options }),
    listMailboxes: (query) => request('listMailboxes', { query }),
    createMailbox: (json, options) => request('createMailbox', { json, options }),
    updateMailbox: (mailboxId, json) => request('updateMailbox', { params: { mailboxId }, json }),
    createAlias: (json, options) => request('createAlias', { json, options }),
    deleteAlias: (address) => request('deleteAlias', { params: { address } }),
    listMembers: (query) => request('listMembers', { query }),
    listLinkLocations: () => request('listLinkLocations'),
    createLinkLocation: (json, options) => request('createLinkLocation', { json, options }),
    rotateLinkLocationCredentials: (locationId, json) => request('rotateLinkLocationCredentials', { params: { locationId }, json }),
    deleteLinkLocation: (locationId) => request('deleteLinkLocation', { params: { locationId } }),
  };
}
