// The content origin and the mail app origin (docs/content-origin.md, section 1):
// canonical origins (https, no path and no trailing slash), on separate hosts.
// mail-content refuses to serve otherwise, and the deploy-time link check
// (tools/link-storage-check) applies the same rule before a link-enabled deploy.

export interface ContentOrigins {
  /** `https://content.<content-domain>` */
  contentOrigin: string;
  /** `https://mail.<suite-domain>` */
  appOrigin: string;
  /** Local HTTP fixtures only; both origins must be different loopback hosts. */
  localLoopback?: boolean;
}

function bareOrigin(value: string, localLoopback: boolean): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const loopback = url?.hostname === 'localhost' || url?.hostname === '127.0.0.1';
  if (!url || url.origin !== value || (url.protocol !== 'https:' && !(localLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('invalid content or app origin');
  }
  return url;
}

/** Both origins parsed, or a TypeError if either is not canonical or they share a host. */
export function separateOrigins(origins: ContentOrigins): { content: URL; app: URL } {
  const content = bareOrigin(origins.contentOrigin, origins.localLoopback === true);
  const app = bareOrigin(origins.appOrigin, origins.localLoopback === true);
  if (content.protocol !== app.protocol || content.hostname === app.hostname) throw new TypeError('content and app origins must be separate');
  return { content, app };
}
