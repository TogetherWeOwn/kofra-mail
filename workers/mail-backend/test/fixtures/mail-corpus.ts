// Seeded MIME messages for the parser equivalence test: random trees of
// multipart, text, binary, calendar and message/rfc822 parts, with the
// encodings, charsets, filenames, line endings and boundary damage seen in
// real and hostile mail.

export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rng, items: readonly T[]): T => items[int(r, items.length)];
const chance = (r: Rng, p: number) => r() < p;

const latin1 = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

const WORDS = ['report', 'Grüße', 'café', '日本語', 'naïve', 'Ωmega', 'plain', 'déjà', 'résumé', 'invoice', '😀', 'quarterly'];

function content(r: Rng, large: boolean): Uint8Array {
  const size = large ? 256 * 1024 + int(r, 64 * 1024) : pick(r, [0, 1, 2, 3, 57, 58, 100, int(r, 4000), int(r, 20_000)]);
  switch (int(r, 4)) {
    case 0: { // binary
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = int(r, 256);
      return bytes;
    }
    case 1: { // UTF-8 text with line breaks
      let text = '';
      while (text.length < size) text += pick(r, WORDS) + pick(r, [' ', ' ', '\r\n', '\n', '\t', '=', '.']);
      return utf8(text.slice(0, size));
    }
    case 2: { // ASCII text with long lines
      let text = '';
      while (text.length < size) text += chance(r, 0.02) ? '\r\n' : String.fromCharCode(32 + int(r, 95));
      return latin1(text);
    }
    default: { // 8-bit latin-1 text
      let text = '';
      while (text.length < size) text += chance(r, 0.05) ? '\n' : String.fromCharCode(int(r, 2) ? 32 + int(r, 95) : 160 + int(r, 96));
      return latin1(text);
    }
  }
}

function base64(r: Rng, bytes: Uint8Array, eol: string): string {
  let encoded = Buffer.from(bytes).toString('base64');
  const variant = int(r, 10);
  if (variant === 0) encoded = encoded.replace(/=+$/, ''); // missing padding
  if (variant === 1 && encoded.length > 8) encoded = encoded.slice(0, encoded.length - 1 - int(r, 3)); // odd length
  if (variant === 2 && encoded.length > 8) { // garbage characters
    const at = int(r, encoded.length);
    encoded = encoded.slice(0, at) + pick(r, ['!', '*', ' ', 'é', '-', '==', '%']) + encoded.slice(at);
  }
  const width = pick(r, [76, 76, 76, 64, 72, 1000, 3, 0]);
  if (!width) return encoded;
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += width) lines.push(encoded.slice(i, i + width) + (chance(r, 0.03) ? ' ' : ''));
  return lines.join(eol);
}

function quotedPrintable(r: Rng, bytes: Uint8Array, eol: string): string {
  let out = '';
  let line = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let token: string;
    if (b === 0x0a && chance(r, 0.8)) { out += line + eol; line = ''; continue; }
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    if ((b >= 33 && b <= 126 && b !== 61) || (b === 32 && bytes[i + 1] !== 0x0a)) token = String.fromCharCode(b);
    else token = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (chance(r, 0.002)) token = pick(r, ['=ZZ', '=4', '=\t', '= 41', '=a9']); // invalid or lower-case escapes
    if (line.length + token.length > 75) { out += `${line}=${eol}`; line = ''; }
    line += token;
  }
  return out + line + (chance(r, 0.1) ? '=' : '');
}

function raw(r: Rng, bytes: Uint8Array, eol: string): Uint8Array {
  // 7bit, 8bit, binary and unknown encodings keep the bytes; rewrite line ends.
  if (chance(r, 0.5)) return bytes;
  const text = Array.from(bytes, b => String.fromCharCode(b)).join('').replace(/\r?\n/g, eol);
  return latin1(text);
}

function encodeWord(r: Rng, value: string): string {
  if (chance(r, 0.5)) return `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
  return `=?utf-8?Q?${Array.from(utf8(value), b => b > 32 && b < 127 && b !== 61 && b !== 63 && b !== 95 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')}?=`;
}

function filename(r: Rng): string | null {
  const name = `${pick(r, WORDS)}-${int(r, 100)}.${pick(r, ['bin', 'pdf', 'png', 'txt', 'eml', 'ics'])}`;
  switch (int(r, 7)) {
    case 0: return null;
    case 1: return `; filename="${encodeWord(r, name)}"`;
    case 2: return `; filename*=UTF-8''${encodeURIComponent(name)}`;
    case 3: {
      const encoded = encodeURIComponent(name);
      const cut = Math.max(1, int(r, encoded.length));
      return `; filename*0*=UTF-8''${encoded.slice(0, cut).replace(/%[0-9A-F]?$/, '')}; filename*1*=${encoded.slice(cut).replace(/^[0-9A-F]{1,2}(?=%|$)/, '')}`;
    }
    case 4: return `; filename=${name.replace(/[^\x21-\x7e]/g, '_')}`;
    default: return `; filename="${name}"`;
  }
}

type Built = { headers: string[]; body: Uint8Array };
type Ctx = { r: Rng; eol: string; depth: number; large: number };

const CHARSETS = ['utf-8', 'UTF-8', 'iso-8859-1', 'windows-1252', 'utf-16le', 'x-unknown', 'iso-8859-8-i', ''];
const ENCODINGS = ['base64', 'BASE64', 'quoted-printable', '7bit', '8bit', 'binary', '', 'x-uuencode', 'base64; junk'];

function encodePart(ctx: Ctx, type: string, bytes: Uint8Array): Built {
  const { r, eol } = ctx;
  const encoding = pick(r, ENCODINGS);
  const headers: string[] = [];
  if (type) headers.push(`Content-Type: ${type}`);
  if (encoding) headers.push(`Content-Transfer-Encoding: ${encoding}`);
  let body: Uint8Array;
  if (/base64/i.test(encoding)) body = latin1(base64(r, bytes, eol));
  else if (/quoted-printable/i.test(encoding)) body = latin1(quotedPrintable(r, bytes, eol));
  else body = raw(r, bytes, eol);
  return { headers, body };
}

function leaf(ctx: Ctx): Built {
  const { r } = ctx;
  const large = ctx.large > 0 && chance(r, 0.3);
  if (large) ctx.large--;
  const charset = pick(r, CHARSETS);
  const cs = charset ? `; charset=${charset}` : '';
  const kind = int(r, 14);
  const disposition = (value: string) => `Content-Disposition: ${value}${filename(r) ?? ''}`;
  switch (kind) {
    case 0: case 1: { // text/plain, sometimes format=flowed
      const part = encodePart(ctx, `text/plain${cs}${chance(r, 0.2) ? '; format=flowed; delsp=yes' : ''}`, content(r, false));
      if (chance(r, 0.15)) part.headers.push(disposition('attachment'));
      return part;
    }
    case 2: return encodePart(ctx, `text/html${cs}`, utf8(`<p>${pick(r, WORDS)}</p><img src="${pick(r, ['cid:x', 'https://example.test/i.png', 'data:x,y'])}">`));
    case 3: case 4: case 5: { // binary attachment
      const part = encodePart(ctx, `${pick(r, ['application/octet-stream', 'application/pdf', 'x-foo/bar', 'APPLICATION/ZIP'])}${chance(r, 0.4) ? `; name="${pick(r, WORDS)}.bin"` : ''}`, content(r, large));
      if (chance(r, 0.7)) part.headers.push(disposition(pick(r, ['attachment', 'inline', 'ATTACHMENT', 'weird'])));
      return part;
    }
    case 6: { // inline image
      const part = encodePart(ctx, 'image/png', content(r, large));
      part.headers.push(`Content-ID: <img${int(r, 1000)}@example.test>`);
      if (chance(r, 0.5)) part.headers.push('Content-Disposition: inline');
      if (chance(r, 0.3)) part.headers.push('Content-Description: a picture');
      return part;
    }
    case 7: { // calendar
      const body = `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nSUMMARY:${pick(r, WORDS)}\r\n${large ? 'X:'.padEnd(300_000, 'y') : ''}\r\nEND:VCALENDAR\r\n\r\n`;
      const part = encodePart(ctx, `${pick(r, ['text/calendar', 'application/ics'])}; method=request${cs}`, utf8(body));
      if (chance(r, 0.5)) part.headers.push(disposition('attachment'));
      return part;
    }
    case 8: case 9: { // message/rfc822
      const inner = message({ ...ctx, depth: ctx.depth + 1, large: large ? 1 : 0 });
      const part = encodePart(ctx, 'message/rfc822', inner);
      const choice = int(r, 3);
      if (choice === 1) part.headers.push(disposition('attachment'));
      if (choice === 2) part.headers.push('Content-Disposition: inline');
      return part;
    }
    case 10: return encodePart(ctx, 'message/delivery-status', utf8('Reporting-MTA: dns; example.test\r\n\r\nAction: failed\r\n'));
    case 11: return encodePart(ctx, '', content(r, large)); // no Content-Type header
    case 12: { // duplicate content headers
      const part = encodePart(ctx, 'application/octet-stream', content(r, large));
      part.headers.push(`Content-Type: ${pick(r, ['text/plain', 'image/gif'])}`, 'Content-Transfer-Encoding: 7bit', 'Content-Disposition: attachment; filename=dup.bin');
      return part;
    }
    default: return { headers: ['Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename=empty.bin'], body: new Uint8Array(0) };
  }
}

let boundaryCounter = 0;
function multipart(ctx: Ctx): Built {
  const { r, eol } = ctx;
  const subtype = pick(r, ['mixed', 'mixed', 'alternative', 'related', 'digest', 'report', 'signed']);
  // Sometimes a boundary that is a prefix of a sibling's or a child's boundary.
  const boundary = chance(r, 0.2) ? `b${boundaryCounter++ % 3}` : `=_${int(r, 1e9).toString(36)}_${boundaryCounter++}`;
  const quoted = chance(r, 0.5) ? `"${boundary}"` : boundary;
  const headers = [`Content-Type: multipart/${subtype}; boundary=${quoted}`];
  const children = Array.from({ length: 1 + int(r, 4) }, () => entity({ ...ctx, depth: ctx.depth + 1 }));
  const parts: Uint8Array[] = [];
  if (chance(r, 0.2)) parts.push(latin1(`This is a preamble.${eol}`));
  for (const child of children) {
    const trailing = chance(r, 0.05) ? pick(r, [' ', '\t', ' x']) : '';
    parts.push(latin1(`--${boundary}${trailing}${eol}`));
    if (subtype === 'digest' && chance(r, 0.5)) child.headers = child.headers.filter(h => !/^content-type:/i.test(h));
    const noBlank = chance(r, 0.03) && child.body.byteLength === 0;
    parts.push(utf8(child.headers.join(eol) + (noBlank ? eol : eol + eol)), child.body, latin1(eol));
  }
  if (!chance(r, 0.1)) parts.push(latin1(`--${boundary}--${chance(r, 0.05) ? ' ' : ''}${eol}`)); // sometimes no terminator
  if (chance(r, 0.1)) parts.push(latin1(`epilogue${eol}`));
  return { headers, body: concat(parts) };
}

function entity(ctx: Ctx): Built {
  return ctx.depth < 5 && chance(ctx.r, ctx.depth === 0 ? 0.8 : 0.3) ? multipart(ctx) : leaf(ctx);
}

function message(ctx: Ctx): Uint8Array<ArrayBuffer> {
  const { r, eol } = ctx;
  const headers = [
    `From: ${pick(r, ['Sender <sender@example.test>', 'a@example.test, b@example.test', `${encodeWord(r, 'Grüße')} <g@example.test>`, 'group: x@example.test, y@example.test;', ''])}`,
    `To: ${pick(r, ['rcpt@example.test', 'R <r@example.test>, s@example.test', 'undisclosed-recipients:;'])}`,
    `Subject: ${pick(r, ['Re: Fwd: hello', encodeWord(r, `Résumé ${pick(r, WORDS)}`), 'plain subject', ''])}`,
    `Message-ID: ${pick(r, [`<m${int(r, 1e6)}@example.test>`, 'not-an-id', `<a@x> <b@y>`, ''])}`,
    `Date: ${chance(r, 0.9) ? 'Thu, 01 Jan 2026 00:00:00 +0000' : pick(r, ['garbage date', ''])}`,
  ];
  if (chance(r, 0.3)) headers.push(`References: <r1@example.test>${eol} <r2@example.test>`, 'In-Reply-To: <r2@example.test>');
  if (chance(r, 0.2)) headers.push(`Cc: c@example.test${eol}\td@example.test`);
  if (chance(r, 0.7)) headers.push('MIME-Version: 1.0');
  const body = entity(ctx);
  return concat([utf8([...headers, ...body.headers].join(eol) + eol + eol), body.body]);
}

export function corpusMessage(seed: number): Uint8Array<ArrayBuffer> {
  const r = rng(seed);
  const eol = pick(r, ['\r\n', '\r\n', '\n', '\r\r\n']);
  const bytes = message({ r, eol, depth: 0, large: chance(r, 0.1) ? 2 : 0 });
  // Occasionally a bare CR inside a line.
  if (chance(r, 0.1) && bytes.byteLength > 10) bytes[int(r, bytes.byteLength)] = 0x0d;
  return bytes;
}
