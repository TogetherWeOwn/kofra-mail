import { Parser } from 'htmlparser2';

const INDEX_BODY_BYTES = 64 * 1024;
// A mail author can omit </head>; skip head-only elements, not the optional container.
const OMIT = new Set(['title', 'script', 'style', 'template', 'noscript', 'noframes']);
const BREAK = new Set(['p', 'br', 'hr', 'div', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th',
  'blockquote', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption',
  'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function bodyForIndex(text: string | undefined, html: string | undefined): string {
  const buffer = new Uint8Array(INDEX_BODY_BYTES);
  const encoder = new TextEncoder();
  let offset = 0;
  if (text) {
    offset = encoder.encodeInto(text, buffer).written;
  } else if (html) {
    let hidden = 0;
    let capped = false;
    const append = (fragment: string) => {
      if (hidden || capped) return;
      if (offset === 0) fragment = fragment.trimStart();
      const { written, read } = encoder.encodeInto(fragment, buffer.subarray(offset));
      offset += written;
      if (offset === buffer.length || read < fragment.length) {
        capped = true;
        parser.pause();
      }
    };
    const parser = new Parser({
      onopentagname: name => {
        if (OMIT.has(name)) hidden++;
        else if (BREAK.has(name)) append(' ');
      },
      onclosetag: name => {
        if (OMIT.has(name)) hidden = Math.max(0, hidden - 1);
        else if (BREAK.has(name)) append(' ');
      },
      ontext: append,
    }, { decodeEntities: true });
    parser.write(html);
    if (!capped) parser.end();
  }
  return new TextDecoder().decode(buffer.subarray(0, offset));
}
