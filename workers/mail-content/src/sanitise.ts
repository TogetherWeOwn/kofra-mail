import { sanitiseCss } from './css.ts';
import { cssUrl, decodeAttribute, escapeAttribute, escapeText, getContentId, isAnchorUrl, isDataImage,
  isRemoteImageUrl, isWebUrl, quoteEncodedAttribute, trimUrl } from './urls.ts';

export const SANITIZER_VERSION = 1;

export type ContentRef = { kind: 'cid'; contentId: string } | { kind: 'img'; url: string };
export interface SanitisedBody {
  html: string;
  refs: ContentRef[];
  version: number;
}
export interface SanitiseOptions {
  ri?: boolean;
  verdict?: string;
}

const kept = new Set('a abbr b blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins li ol p pre q s small span strike strong style sub sup table tbody td tfoot th thead tr tt u ul wbr'.split(' '));
const removed = new Set('script noscript template iframe frame frameset object embed applet form input button select textarea option svg math link meta base title audio video source track canvas xmp noembed noframes plaintext listing'.split(' '));
const voidKept = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const globalAttrs = new Set('align valign bgcolor color width height border cellpadding cellspacing colspan rowspan dir lang class style title'.split(' '));
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const prefix = '<!doctype html><html><head><meta charset="utf-8"><style>body { font-family: system-ui, sans-serif; overflow-wrap: anywhere; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } img { max-width: 100%; }</style></head><body>';
const emptyImage = '<span></span>';

function wrap(body: string, refs: ContentRef[] = []): SanitisedBody {
  return { html: `${prefix}${body}</body></html>`, refs, version: SANITIZER_VERSION };
}

export function sanitisePlainText(text: string): SanitisedBody {
  // HTML consumes the first LF after a pre start tag.
  return wrap(`<pre>\n${escapeText(text)}</pre>`);
}

type RefContext = 'h' | 'a' | 's'; // HTML src attribute, CSS attribute, raw CSS
function slot(context: RefContext, index: number): string {
  // NUL is never emitted from untrusted text, attributes or CSS. It reserves a
  // disjoint namespace even when an email contains strings resembling slots.
  return `\0${context}${index}\0`;
}

export async function sanitise(html: string, { ri = false, verdict }: SanitiseOptions = {}): Promise<SanitisedBody> {
  const result: string[] = [];
  const refs: ContentRef[] = [];
  const remoteAllowed = ri && verdict !== 'phishing';
  let remoteCount = 0;
  let styleParts: string[] | undefined;

  function ref(context: RefContext, value: ContentRef): string {
    if (value.kind === 'img') {
      if (!remoteAllowed || remoteCount >= 100) return context === 'h' ? '' : 'none';
      remoteCount++;
    }
    return slot(context, refs.push(value) - 1);
  }

  function css(input: string, inline: boolean): string {
    return sanitiseCss(input, inline).map(part => {
      if (typeof part === 'string') return inline ? escapeAttribute(part) : part;
      return ref(inline ? 'a' : 's', { kind: 'img', url: part.url });
    }).join('').trimEnd();
  }

  function attributes(tag: string, attrs: Iterable<string[]>): string {
    let output = '';
    const seen = new Set<string>();
    for (const [name, raw] of attrs) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === 'style') {
        const decoded = decodeAttribute(raw);
        const value = decoded === undefined ? '' : css(decoded, true);
        if (value) output += ` style="${value}"`;
      } else if (name === 'href' && tag === 'a' && verdict !== 'phishing') {
        const url = trimUrl(decodeAttribute(raw) ?? '');
        if (isAnchorUrl(url)) output += ` href="${escapeAttribute(url)}"`;
      } else if (globalAttrs.has(name) || (tag === 'img' && name === 'alt')) {
        output += ` ${name}="${quoteEncodedAttribute(raw)}"`;
      }
    }
    if (tag === 'a') output += ' target="_blank" rel="noopener noreferrer"';
    return output;
  }

  try {
    // HTMLRewriter's remove/replace handles element content including raw-text
    // states and implied boundaries. Its callbacks still see removed children,
    // so collect references and build output in a second pass, never the first.
    const cleaned = await new HTMLRewriter().on('*', {
      element(element) {
        if (removed.has(element.tagName) || element.namespaceURI !== htmlNamespace) {
          // Keep a lexical boundary for the second pass: text on opposite sides
          // of a removed element must not be joined and reinterpreted as markup.
          element.replace('<!---->', { html: true });
        }
      },
    }).transform(new Response(html)).text();

    await new HTMLRewriter().on('*', {
      element(element) {
        const tag = element.tagName;
        if (removed.has(tag) || element.namespaceURI !== htmlNamespace) {
          throw new TypeError('Uncertain HTML structure');
        }
        if (!kept.has(tag)) return; // unwrap; descend without copying the tag
        if (tag === 'style') {
          const attrs = [...element.attributes];
          const parts: string[] = [];
          styleParts = parts;
          element.onEndTag(() => {
            result.push(`<style${attributes(tag, attrs)}>${css(parts.join(''), false)}</style>`);
            styleParts = undefined;
          });
          // An unclosed style is not emitted; no original raw text is copied.
          return;
        }
        let src = '';
        if (tag === 'img') {
          const value = trimUrl(decodeAttribute(element.getAttribute('src') ?? '') ?? '');
          const contentId = getContentId(value);
          if (contentId) src = ref('h', { kind: 'cid', contentId });
          else if (isDataImage(value)) src = ` src="${escapeAttribute(value)}"`;
          else if (isWebUrl(value)) {
            src = isRemoteImageUrl(value) ? ref('h', { kind: 'img', url: value }) : '';
            if (!src) {
              result.push(emptyImage);
              return;
            }
          }
        }
        result.push(`<${tag}${attributes(tag, element.attributes)}${src}>`);
        if (!voidKept.has(tag)) element.onEndTag(() => { result.push(`</${tag}>`); });
      },
    }).onDocument({
      text(chunk) {
        if (styleParts) {
          styleParts.push(chunk.text);
        } else {
          // Text tokens retain HTML entities. Keep those entities, but never
          // carry a literal delimiter into the newly serialized document.
          result.push(chunk.text.replaceAll('<', '&lt;').replaceAll('\0', '�'));
        }
      },
    }).transform(new Response(cleaned)).text();
  } catch (error) {
    // workerd can refuse ambiguous raw-text parsing in malformed markup.
    // A partial transform is not a safe document or a complete ref manifest.
    if (error instanceof TypeError && (error.message.startsWith('Parser error:') || error.message === 'Uncertain HTML structure')) return wrap('');
    throw error;
  }
  return wrap(result.join(''), refs);
}

/** Fill a trusted sanitiser result with the caller's per-response image URLs. */
export async function fillRefs(
  output: SanitisedBody,
  mint: (ref: ContentRef, index: number) => string | null | Promise<string | null>,
): Promise<string> {
  const urls = await Promise.all(output.refs.map(mint));
  return output.html.replace(/\0([has])(\d+)\0/g, (_, context: RefContext, index: string) => {
    const url = urls[Number(index)];
    if (!url || !isWebUrl(url)) return context === 'h' ? '' : 'none';
    if (context === 'h') return ` src="${escapeAttribute(url)}"`;
    const value = cssUrl(url);
    return context === 'a' ? escapeAttribute(value) : value;
  });
}
