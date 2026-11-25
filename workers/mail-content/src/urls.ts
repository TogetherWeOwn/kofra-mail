const badUrlChar = /[\u0000-\u0020\u007f-\u009f\\]/u;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

// HTMLRewriter returns encoded attribute values. Decode a known subset for
// interpretation and discard URLs/CSS with ambiguous character references.
const named = new Map(Object.entries({
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"',
  apos: "'", nbsp: '\u00a0', colon: ':', sol: '/', bsol: '\\', Tab: '\t', NewLine: '\n',
}));

// The 106 case-sensitive HTML named character references defined without a
// semicolon in the WHATWG entity table. Only prefix matching is needed here.
const legacyNamed = new Set(`AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc
Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml
Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg
divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt
macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot
raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml`.split(/\s+/));
const longestLegacyName = Math.max(...Array.from(legacyNamed, name => name.length));

function semicolonlessIsLiteral(input: string, offset: number, token: string): boolean {
  for (let length = Math.min(longestLegacyName, token.length - 1); length > 0; length--) {
    if (!legacyNamed.has(token.slice(1, length + 1))) continue;
    // In an attribute, only a following ASCII alphanumeric or '=' makes
    // the longest semicolonless match literal. In other cases fail closed.
    return /^[a-z\d=]$/i.test(input[offset + length + 1] ?? '');
  }
  return true;
}

export function decodeAttribute(input: string): string | undefined {
  let valid = true;
  const decoded = input.replace(/&(?:#(?:x[\da-f]+|\d+);?|[a-z][a-z\d]*;?)/gi, (token, offset: number) => {
    if (token.startsWith('&#')) {
      const hex = token[2]?.toLowerCase() === 'x';
      const point = parseInt(token.slice(hex ? 3 : 2), hex ? 16 : 10);
      // Reject invalid scalars and the HTML legacy numeric-control rewrites.
      if (point === 0 || point > 0x10ffff || (point >= 0x80 && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff)) {
        valid = false;
        return '';
      }
      return String.fromCodePoint(point);
    }
    if (token.endsWith(';')) {
      const char = named.get(token.slice(1, -1));
      if (char !== undefined) return char;
    } else if (semicolonlessIsLiteral(input, offset, token)) {
      return token;
    }
    valid = false;
    return '';
  });
  return valid ? decoded : undefined;
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\0', '\ufffd');
}

// The original attribute is already encoded; its references stay references
// inside the new quotes, with any literal delimiters escaped.
export function quoteEncodedAttribute(value: string): string {
  return value.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\0', '\ufffd');
}

export function trimUrl(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

export function isWebUrl(value: string): boolean {
  if (!/^https?:\/\/[^/]/i.test(value) || badUrlChar.test(value)) return false;
  const url = URL.parse(value);
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:');
}

export function isRemoteImageUrl(value: string): boolean {
  return value.length <= 2048 && isWebUrl(value) && byteLength(value) <= 2048;
}

export function isAnchorUrl(value: string): boolean {
  return isWebUrl(value) || (/^mailto:[^?]/i.test(value) && !badUrlChar.test(value) && URL.parse(value)?.protocol === 'mailto:');
}

export function getContentId(value: string): string | undefined {
  if (!/^cid:/i.test(value)) return undefined;
  try {
    const id = decodeURIComponent(value.slice(4));
    if (id && !badUrlChar.test(id) && !/[<>]/.test(id)) return id;
  } catch {
    // Ignore malformed percent encoding.
  }
}

const dataLimit = 64 * 1024;
export function isDataImage(value: string): boolean {
  if (value.length > dataLimit * 3 + 32) return false;
  const match = /^data:image\/(?:png|jpeg|gif|webp)(;base64)?,(.+)$/i.exec(value);
  if (!match) return false;
  const [, base64, payload] = match;
  if (base64) {
    if (payload.length > Math.ceil(dataLimit / 3) * 4 || !/^[a-z\d+/]+={0,2}$/i.test(payload)) return false;
    try { return atob(payload).length <= dataLimit; } catch { return false; }
  }
  return /^(?:%[\da-f]{2}|[a-z\d!$&'()*+,./:;=?_~-])+$/i.test(payload) &&
    payload.replace(/%[\da-f]{2}/gi, '_').length <= dataLimit;
}

export function cssUrl(url: string): string {
  const quoted = url.replace(/["\\<>\u0000-\u001f\u007f]/g, c => `\\${c.charCodeAt(0).toString(16)} `);
  return `url("${quoted}")`;
}
