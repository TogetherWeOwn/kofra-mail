// The download page of a file link (docs/m3-outbound-plan.md, M3-13): the file's
// name and size, who sent it, until when it is available, a Download button and
// "Report abuse". It has its own CSP and no script. Every untrusted value (file
// name, sender name and address) is HTML-escaped for its context, with bidi and
// other control characters removed, so a name can only ever render as text.

/** The page's own policy: no script, no subresource, inline style only, forms back to this host only. */
export const LINK_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
/** Downloads are never rendered (content-origin sections 3.1 and 3.4). */
export const LINK_DOWNLOAD_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

/** Removes bidi controls and every other control character. */
export const visibleText = (value: string) => value.toWellFormed().replace(/[\p{Bidi_Control}\p{Cc}]/gu, '');

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escapes text for element content and quoted attribute values, after removing controls. */
export const escapeHtml = (value: string) => visibleText(value).replace(/[&<>"']/g, char => ESCAPES[char]);

/** A size for people: bytes, then KB, MB and GB (1,024-based), one decimal below 10. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? (Math.floor(value * 10) / 10).toFixed(1) : Math.floor(value)} ${units[unit]}`;
}

/** `YYYY-MM-DD HH:MM UTC`, as the message printed it. */
export const formatExpiry = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const STYLE = `:root{color-scheme:light dark;--bg:#f6f6f3;--surface:#fff;--ink:#121412;--body:#3f423d;--muted:#5f625c;--line:#dadad3;
--action:#1f4fd1;--action-ink:#fff;--accent:#1d49c2;--warning:#805200;--warning-bg:#fbf0d8}
@media (prefers-color-scheme:dark){:root{--bg:#141614;--surface:#171917;--ink:#f1f2ee;--body:#c9cbc4;--muted:#9a9d95;--line:#2c2f2b;
--action:#6f95ff;--action-ink:#0b0d18;--accent:#9ab4ff;--warning:#f0b43c;--warning-bg:#302616}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;font:15px/1.5 'IBM Plex Sans Variable',system-ui,sans-serif;
color:var(--ink);background:var(--bg)}
main{width:min(100%,520px);padding:28px 24px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
h1{margin:0 0 4px;font-size:1.07rem;font-weight:600;color:var(--muted)}
.file{margin:0 0 20px;font-size:1.5rem;font-weight:600;line-height:1.25;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0 0 24px;color:var(--body)}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.download{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 20px;border-radius:6px;
background:var(--action);color:var(--action-ink);font-weight:600;text-decoration:none}
.download:hover{filter:brightness(.93)}
:focus-visible{outline:2px solid var(--action);outline-offset:2px}
.note{margin:20px 0 0;padding:10px 12px;border-radius:6px;background:var(--warning-bg);color:var(--ink);font-size:.93rem}
form{margin:16px 0 0}
.report{min-height:44px;padding:0;border:0;background:none;color:var(--accent);font:inherit;text-decoration:underline;cursor:pointer}
p{margin:0}`;

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`
    + `<body><main>${body}</main></body></html>`;
}

export type LinkPageInput = {
  /** The link token, already checked to be 22 base64url characters. */
  token: string;
  name: string;
  size: number;
  sender: { name: string; email: string };
  expiresAt: number | null;
};

/** The download page. Only the token reaches a URL, and it was validated before this call. */
export function linkPage(input: LinkPageInput): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.token)) throw new Error('Invalid link token');
  const sender = visibleText(input.sender.name).trim();
  const from = sender ? `${escapeHtml(sender)} &lt;${escapeHtml(input.sender.email)}&gt;` : escapeHtml(input.sender.email);
  const until = input.expiresAt === null ? 'No expiry date' : `Until ${escapeHtml(formatExpiry(input.expiresAt))}`;
  return document('Shared file', `<h1>Shared file</h1><p class="file">${escapeHtml(input.name)}</p>`
    + `<dl><dt>Size</dt><dd>${escapeHtml(formatSize(input.size))}</dd><dt>From</dt><dd>${from}</dd>`
    + `<dt>Available</dt><dd>${until}</dd></dl>`
    + `<a class="download" href="/f/${input.token}/download" download>Download</a>`
    + `<p class="note">Files are not scanned for viruses. Only open files you expect.</p>`
    + `<form method="post" action="/f/${input.token}/report"><button class="report" type="submit">Report abuse</button></form>`);
}

/** The one answer for an unknown, revoked, expired or undone link: it reveals nothing. */
export const unavailablePage = () => document('Link unavailable',
  '<h1>Link unavailable</h1><p class="file">This link has expired or was removed.</p><p>Ask the sender for a new link.</p>');

/** The limit page keeps "Report abuse": a link spent by abuse can still be reported. */
export const limitPage = (token: string) => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) throw new Error('Invalid link token');
  return document('Download limit reached', '<h1>Download limit reached</h1><p class="file">This file has been downloaded too often.</p>'
    + '<p>Try again later, or ask the sender for a new link.</p>'
    + `<form method="post" action="/f/${token}/report"><button class="report" type="submit">Report abuse</button></form>`);
};

export const busyPage = () => document('Try again', '<h1>Try again</h1><p class="file">This link cannot be opened right now.</p><p>Try again in a minute.</p>');

export const reportedPage = () => document('Report sent', '<h1>Report sent</h1><p class="file">Thank you. The link was reported.</p>');

/** Headers for the page and every HTML answer of a link route. */
export function linkPageHeaders(): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': LINK_PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
}

/**
 * `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>`
 * (content-origin section 3.4): controls, bidi controls, `/` and `\` removed, at
 * most 255 bytes; in the fallback `"`, `\`, `;` and every non-ASCII character become `_`.
 */
export function linkDisposition(filename: string): string {
  let name = visibleText(filename).replace(/[/\\]/g, '');
  const encoder = new TextEncoder();
  while (encoder.encode(name).byteLength > 255) name = [...name].slice(0, -1).join('');
  if (!name) name = 'download';
  const fallback = name.replace(/[";\\]|[^\x20-\x7e]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
