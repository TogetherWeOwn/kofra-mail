import { getDomain } from 'tldts';

const loopback = new Set(['localhost', '127.0.0.1']);
const parseAbsoluteHttp = (value: string) => /^https?:\/\/[^/\\\s]/i.test(value) && !/[\s\\]/.test(value) ? URL.parse(value) : null;

/** Frame origins come from trusted server configuration, not mailbox data. */
export function separateContentOrigin(value: string | undefined, app: URL, dev: boolean): string | undefined {
  if (!value) return undefined;
  const url = parseAbsoluteHttp(value);
  if (!url || url.username || url.password || url.href !== `${url.origin}/` || url.hostname === app.hostname) return undefined;
  if (dev && url.protocol === 'http:' && loopback.has(app.hostname) && loopback.has(url.hostname)) return url.origin;
  if (url.protocol !== 'https:') return undefined;
  const options = { allowPrivateDomains: true };
  const appSite = getDomain(app.hostname, options);
  const contentSite = getDomain(url.hostname, options);
  return appSite && contentSite && appSite !== contentSite ? url.origin : undefined;
}

/** Do not send frame navigations to an origin supplied by a message. */
export function contentFrameUrl(value: string | undefined, origin: string | undefined): string | undefined {
  if (!value || !origin) return undefined;
  const url = parseAbsoluteHttp(value);
  return url && url.origin === origin && !url.username && !url.password ? url.href : undefined;
}
