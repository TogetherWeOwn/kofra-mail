import { WorkerEntrypoint } from 'cloudflare:workers';
import { indexedAttachmentName } from '../../../contracts/mail-api/src/headers.ts';
import { sha256 } from '../../mail-backend/src/bytes.ts';
import { serveImage, type ImageCache } from './image-handler.ts';
import { contentUrlKeys, type ContentUrlKeys } from './keys.ts';
import { checkedRecord, decodedBytes, readOnlyObjects, type ContentStoreConfig } from './object-reader.ts';
import {
  checkRemoteImageUrl, contentSecurityHeaders, isInlineImage, remoteImageConfig, remoteImageMethodAllowed, type ContentOrigins,
} from './proxy.ts';
import { fillRefs, sanitise, sanitisePlainText } from './sanitise.ts';
import { CONTENT_URL_SECONDS, isPurpose, mintForWeb, type ClaimsByPurpose, type Purpose, type WebPurpose } from './tokens.ts';
import { attachmentFor, createVerifier, EpochCache, mintFromBody, type Verified } from './verify.ts';

export interface AccountEpochPort { credentialEpoch(sub: string): Promise<number | null> }
export interface MailLookupPort {
  mailboxOwner(ws: string, mb: string): Promise<string | null>;
  messageRecord(ws: string, mb: string, sub: string, msg: string): Promise<unknown>;
}
export type ContentEnv = ContentStoreConfig & {
  MAIL_LOOKUP: MailLookupPort;
  ACCOUNT_EPOCH: AccountEpochPort;
  MAIL_CONTENT_ENABLED?: string;
  CONTENT_URL_KEYS?: string;
  CONTENT_ORIGIN?: string;
  MAIL_APP_ORIGIN?: string;
  CONTENT_ZONE?: string;
  CONTENT_SUITE_DOMAIN?: string;
  CONTENT_STORAGE_DOMAIN?: string;
  CONTENT_ACCOUNT_DOMAIN?: string;
  CONTENT_WORKERS_DEV_DOMAIN?: string;
};

const epochs = new EpochCache();
const encoder = new TextEncoder();
const urlFor = (origin: string, purpose: Purpose, token: string) => `${origin}/v1/${purpose}/${token}`;
const originsFor = (env: ContentEnv): ContentOrigins => ({ contentOrigin: env.CONTENT_ORIGIN ?? '', appOrigin: env.MAIL_APP_ORIGIN ?? '' });

function proxyConfig(env: ContentEnv, origins: ContentOrigins) {
  return remoteImageConfig({
    suiteDomain: env.CONTENT_SUITE_DOMAIN ?? '', contentDomain: env.CONTENT_ZONE ?? '',
    storageDomains: [env.CONTENT_STORAGE_DOMAIN ?? '', URL.parse(env.CONTENT_S3_ENDPOINT ?? '')?.hostname ?? ''],
    accountDomains: [env.CONTENT_ACCOUNT_DOMAIN ?? '', new URL(origins.appOrigin).hostname, new URL(origins.contentOrigin).hostname],
    workersDevSubdomain: env.CONTENT_WORKERS_DEV_DOMAIN ?? '',
  });
}

type WebClaims<P extends WebPurpose> = Omit<ClaimsByPurpose[P], 'v' | 'iat' | 'exp'>;

/** A named service binding only. The default HTTP entrypoint has no mint route. */
export class ContentMint extends WorkerEntrypoint<ContentEnv> {
  async mintForWeb<P extends WebPurpose>(purpose: P, claims: WebClaims<P>) {
    if (this.env.MAIL_CONTENT_ENABLED !== 'on') throw new Error('mail content is disabled');
    const origins = originsFor(this.env);
    contentSecurityHeaders(origins); // Validate trusted origins before signing.
    const keys = await contentUrlKeys(this.env.CONTENT_URL_KEYS ?? '');
    const now = Date.now() / 1000;
    const token = await mintForWeb(keys, purpose, claims, now);
    return { url: urlFor(origins.contentOrigin, purpose, token), expiresAt: new Date((Math.floor(now) + CONTENT_URL_SECONDS) * 1000).toISOString() };
  }
}

function attachmentDisposition(filename: string) {
  const name = indexedAttachmentName(filename.toWellFormed());
  const fallback = name.replace(/[";\\]|[^\x20-\x7e]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveMailbox(verified: Exclude<Verified, { purpose: 'img' }>, env: ContentEnv, keys: ContentUrlKeys,
    origins: ContentOrigins, headers: Headers, now: number): Promise<{ response: Response; bytes: number } | null> {
  const { claims, message, purpose } = verified;
  const entry = purpose !== 'body' ? attachmentFor(message, verified.claims.part) : undefined;
  if (purpose !== 'body' && !entry) return null;
  const objects = readOnlyObjects(env, claims.ws);
  const mime = await objects.mime(message.rawKey);
  if (purpose === 'body') {
    const output = mime.html ? await sanitise(mime.html, { ri: verified.claims.ri, verdict: message.verdict }) : null;
    let body: string;
    if (!output || output.unsafe === 'ambiguous_markup') {
      body = sanitisePlainText(mime.text || 'This message cannot be displayed.').html;
    } else {
      const cidParts = new Map<string, number | null>();
      for (const { part } of message.attachments) {
        const contentId = mime.attachments[part - 1]?.contentId?.trim().replace(/^<(.*)>$/, '$1');
        if (contentId) cidParts.set(contentId, cidParts.has(contentId) ? null : part);
      }
      const config = proxyConfig(env, origins);
      body = await fillRefs(output, async ref => {
        if (ref.kind === 'cid') {
          const part = cidParts.get(ref.contentId);
          return part ? urlFor(origins.contentOrigin, 'cid', await mintFromBody(keys, verified, { purpose: 'cid', part }, now)) : null;
        }
        if (!checkRemoteImageUrl(ref.url, config).ok) return null;
        return urlFor(origins.contentOrigin, 'img', await mintFromBody(keys, verified, { purpose: 'img', u: ref.url }, now));
      });
    }
    const bytes = encoder.encode(body);
    headers.set('content-type', 'text/html; charset=utf-8');
    return { response: new Response(bytes, { headers }), bytes: bytes.byteLength };
  }
  if (!entry) return null;
  const attachment = mime.attachments[entry.part - 1];
  if (!attachment) return null;
  const bytes = decodedBytes(attachment.content);
  if (purpose === 'cid') {
    const type = attachment.mimeType.toLowerCase();
    if (!isInlineImage(type, bytes)) return null;
    headers.set('content-type', type);
    headers.set('content-disposition', 'inline');
    return { response: new Response(bytes, { headers }), bytes: bytes.byteLength };
  }
  headers.set('content-type', 'application/octet-stream');
  headers.set('content-disposition', attachmentDisposition(attachment.filename ?? ''));
  const content = entry.objectKey ? await objects.attachment(entry.objectKey, bytes.byteLength) : bytes;
  return { response: new Response(content, { headers }), bytes: bytes.byteLength };
}

interface Runtime {
  now: () => number;
  imageCache: () => Promise<ImageCache>;
}
const runtime: Runtime = { now: Date.now, imageCache: () => caches.open('mail-content-images-v1') };
const pathPattern = /^\/v1\/(body|cid|att|img)\/([^/]{1,4173})$/;

async function handleContent(request: Request, env: ContentEnv, io: Runtime): Promise<Response> {
  const origins = originsFor(env);
  let headers: Headers;
  try { headers = contentSecurityHeaders(origins); }
  catch {
    headers = contentSecurityHeaders({ contentOrigin: 'https://content.example', appOrigin: 'https://mail.example' });
    headers.set('content-security-policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox");
    return new Response(null, { status: 404, headers });
  }
  const url = new URL(request.url);
  const match = pathPattern.exec(url.pathname);
  if (!match || !isPurpose(match[1]) || url.origin !== origins.contentOrigin || env.MAIL_CONTENT_ENABLED !== 'on') {
    return new Response(null, { status: 404, headers });
  }
  const purpose = match[1], token = match[2];
  let result: { response: Response; bytes: number } | null = null;
  if (purpose === 'img' && !remoteImageMethodAllowed(request.method)) {
    headers.set('allow', 'GET');
    result = { response: new Response(null, { status: 405, headers }), bytes: 0 };
  } else if (request.method === 'GET') {
    try {
      const now = io.now() / 1000;
      const keys = await contentUrlKeys(env.CONTENT_URL_KEYS ?? '');
      const verifier = createVerifier({ keys, epochs, ports: {
        credentialEpoch: sub => env.ACCOUNT_EPOCH.credentialEpoch(sub),
        mailboxOwner: (ws, mb) => env.MAIL_LOOKUP.mailboxOwner(ws, mb),
        message: async (ws, mb, msg, sub) => checkedRecord(await env.MAIL_LOOKUP.messageRecord(ws, mb, sub, msg)),
      } });
      const verified = await verifier.verify(purpose, token, now);
      if (verified.ok) {
        result = verified.purpose === 'img'
          ? await serveImage(verified.claims.u, origins, proxyConfig(env, origins), io.imageCache)
          : await serveMailbox(verified, env, keys, origins, headers, now);
      }
    } catch { /* Fail closed; do not expose or log errors from ports, parsers or keys. */ }
  }
  const status = result?.response.status ?? 404;
  console.log(JSON.stringify({ purpose, status, bytes: result?.bytes ?? 0, token: (await sha256(new Uint8Array(encoder.encode(token)))).slice(0, 8) }));
  return result?.response ?? new Response(null, { status, headers: contentSecurityHeaders(origins) });
}

export async function serveContent(request: Request, env: ContentEnv, io: Runtime = runtime): Promise<Response> {
  const response = await handleContent(request, env, io);
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return response;
}

export default { fetch: (request: Request, env: ContentEnv) => serveContent(request, env) };
