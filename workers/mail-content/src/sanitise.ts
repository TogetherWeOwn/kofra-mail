import { sanitiseCss, type CssPart } from './css.ts';
import { cssUrl, decodeAttribute, escapeAttribute, escapeHtml, escapeText, getContentId, isAnchorUrl, isDataImage,
  isRemoteImageUrl, isWebUrl, measureHtml, trimUrl, type HtmlEscape } from './urls.ts';

export const SANITIZER_VERSION = 2;
export const maxBodyHtmlBytes = 8 * 1024 * 1024;
const maxStyleBytes = 1024 * 1024;

export type ContentRef = { kind: 'cid'; contentId: string } | { kind: 'img'; url: string };
export interface SanitisedBody {
  html: string;
  refs: ContentRef[];
  version: number;
  /** The caller should fall back to plain text or a notice, not display this body. */
  unsafe?: 'ambiguous_markup' | 'output_too_large';
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
const suffix = '</body></html>';

function wrap(body: string, refs: ContentRef[] = []): SanitisedBody {
  return { html: `${prefix}${body}${suffix}`, refs, version: SANITIZER_VERSION };
}

export function sanitisePlainText(text: string): SanitisedBody {
  // HTML consumes the first LF after a pre start tag.
  return wrap(`<pre>\n${escapeText(text)}</pre>`);
}

export function boundedPlainText(text: string, maxBytes: number): string | null {
  const limit = maxBytes - prefix.length - suffix.length - '<pre>\n</pre>'.length;
  return measureHtml(text, limit, 'text') === null ? null : sanitisePlainText(text).html;
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
  const cidSlots = new Map<string, number>();
  const remoteAllowed = ri && verdict !== 'phishing';
  let remoteCount = 0;
  let style: { parts: string[]; bytes: number; dropped: boolean } | undefined;
  const textParts: string[] = [];
  let textBytes = 0;
  let pendingEntity = false;
  let left = maxBodyHtmlBytes - prefix.length - suffix.length;
  let tooLarge = false;

  function measure(value: string, limit: number, mode?: HtmlEscape): number {
    const size = measureHtml(value, limit, mode);
    if (size === null) {
      // Workerd can wrap an HTMLRewriter callback error at the stream boundary.
      tooLarge = true;
      throw new Error('HTML output limit exceeded');
    }
    return size;
  }

  function emit(value: string, mode?: HtmlEscape): string {
    left -= measure(value, left, mode);
    const escaped = mode ? escapeHtml(value, mode) : value;
    if (escaped) result.push(escaped);
    return escaped;
  }

  function emitMarkup(markup: string) {
    pendingEntity = false;
    emit(markup);
  }

  function emitText(text: string) {
    if (!text) return;
    // Keep already-encoded references, but prevent a new entity match across a discarded node.
    if (pendingEntity && /^[a-z\d#;]/i.test(text)) {
      emit(`&#${text.charCodeAt(0)};`);
      text = text.slice(1);
    }
    pendingEntity = /&(?:[a-z\d]*|#[a-z\d]*)$/i.test(emit(text, 'rewriterText'));
  }

  function ref(context: RefContext, value: ContentRef): string {
    if (value.kind === 'img') {
      if (!remoteAllowed || remoteCount >= 100) return context === 'h' ? '' : 'none';
      remoteCount++;
    } else {
      const existing = cidSlots.get(value.contentId);
      if (existing !== undefined) return slot(context, existing);
      cidSlots.set(value.contentId, refs.length);
    }
    return slot(context, refs.push(value) - 1);
  }

  function css(input: string, inline: boolean): CssPart[] {
    const parts = sanitiseCss(input, inline);
    while (parts.length) {
      const last = parts[parts.length - 1];
      if (typeof last !== 'string') break;
      const trimmed = last.trimEnd();
      if (trimmed) { parts[parts.length - 1] = trimmed; break; }
      parts.pop();
    }
    return parts;
  }

  function emitCss(parts: CssPart[], inline: boolean) {
    for (const part of parts) {
      if (typeof part === 'string') emit(part, inline ? 'attribute' : undefined);
      else emit(ref(inline ? 'a' : 's', { kind: 'img', url: part.url }));
    }
  }

  function boundedDecode(raw: string): string | undefined {
    measure(raw, maxBodyHtmlBytes);
    return decodeAttribute(raw);
  }

  function attribute(name: string, value: string, mode: HtmlEscape) {
    emit(` ${name}="`);
    emit(value, mode);
    emit('"');
  }

  function attributes(tag: string, attrs: Iterable<string[]>) {
    const seen = new Set<string>();
    for (const [name, raw] of attrs) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === 'style') {
        const decoded = boundedDecode(raw);
        const parts = decoded === undefined ? [] : css(decoded, true);
        if (parts.length) {
          emit(' style="');
          emitCss(parts, true);
          emit('"');
        }
      } else if (name === 'href' && tag === 'a' && verdict !== 'phishing') {
        const url = trimUrl(boundedDecode(raw) ?? '');
        if (isAnchorUrl(url)) attribute(name, url, 'attribute');
      } else if (globalAttrs.has(name) || (tag === 'img' && name === 'alt')) {
        attribute(name, raw, 'encodedAttribute');
      }
    }
    if (tag === 'a') emit(' target="_blank" rel="noopener noreferrer"');
  }

  try {
    // HTMLRewriter's remove/replace handles element content including raw-text
    // states and implied boundaries. Its callbacks still see removed children,
    // so collect references and build output in a second pass, never the first.
    const cleaned = new HTMLRewriter().on('*', {
      element(element) {
        if (removed.has(element.tagName) || element.namespaceURI !== htmlNamespace) {
          // Keep a lexical boundary for the second pass: text on opposite sides
          // of a removed element must not be joined and reinterpreted as markup.
          element.replace('<!---->', { html: true });
        }
      },
    }).transform(new Response(html));

    const parsed = new HTMLRewriter().on('*', {
      element(element) {
        const tag = element.tagName;
        if (removed.has(tag) || element.namespaceURI !== htmlNamespace) {
          throw new TypeError('Uncertain HTML structure');
        }
        if (!kept.has(tag)) return; // unwrap; descend without copying the tag
        if (tag === 'style') {
          const attrs = [...element.attributes];
          const block = style = { parts: [], bytes: 0, dropped: false };
          element.onEndTag(() => {
            style = undefined;
            if (block.dropped) return;
            emitMarkup('<style');
            attributes(tag, attrs);
            emit('>');
            emitCss(css(block.parts.join(''), false), false);
            emit('</style>');
          });
          // An unclosed style is not emitted; no original raw text is copied.
          return;
        }
        let src = '';
        let data: string | undefined;
        if (tag === 'img') {
          const value = trimUrl(boundedDecode(element.getAttribute('src') ?? '') ?? '');
          const contentId = getContentId(value);
          if (contentId) src = ref('h', { kind: 'cid', contentId });
          else if (isDataImage(value)) data = value;
          else if (isWebUrl(value)) {
            src = isRemoteImageUrl(value) ? ref('h', { kind: 'img', url: value }) : '';
            if (!src) {
              emitMarkup(emptyImage);
              return;
            }
          }
        }
        emitMarkup(`<${tag}`);
        attributes(tag, element.attributes);
        emit(src);
        if (data !== undefined) attribute('src', data, 'attribute');
        emit('>');
        if (!voidKept.has(tag)) element.onEndTag(() => emitMarkup(`</${tag}>`));
      },
    }).onDocument({
      text(chunk) {
        if (style) {
          if (style.dropped) return;
          const size = measureHtml(chunk.text, maxStyleBytes - style.bytes);
          if (size === null) {
            style.dropped = true;
            style.parts.length = 0;
          } else {
            style.bytes += size;
            if (chunk.text) style.parts.push(chunk.text);
          }
        } else {
          textBytes += measure(chunk.text, left - textBytes, 'rewriterText');
          if (chunk.text) textParts.push(chunk.text);
          if (chunk.lastInTextNode) {
            emitText(textParts.join(''));
            textParts.length = 0;
            textBytes = 0;
          }
        }
      },
    }).transform(cleaned);
    // The parser's copy is not the response. Drain it without materialising it.
    await parsed.body?.pipeTo(new WritableStream());
  } catch (error) {
    if (tooLarge) return { ...wrap(''), unsafe: 'output_too_large' };
    // workerd can refuse ambiguous raw-text parsing in malformed markup.
    // Do not serve partial output; report the need for a plain-text fallback.
    if (error instanceof TypeError && (error.message.startsWith('Parser error:') || error.message === 'Uncertain HTML structure')) {
      return { ...wrap(''), unsafe: 'ambiguous_markup' };
    }
    throw error;
  }
  return wrap(result.join(''), refs);
}

type MintRef = (ref: ContentRef, index: number) => string | null | Promise<string | null>;

/** Fill a trusted sanitiser result, with an optional UTF-8 byte ceiling before materialising it. */
export function fillRefs(output: SanitisedBody, mint: MintRef): Promise<string>;
export function fillRefs(output: SanitisedBody, mint: MintRef, maxBytes: number): Promise<string | null>;
export async function fillRefs(output: SanitisedBody, mint: MintRef, maxBytes?: number): Promise<string | null> {
  const urls = await Promise.all(output.refs.map(mint));
  function replacement(_: string, context: RefContext, index: string): string {
    const url = urls[Number(index)];
    if (!url || !isWebUrl(url)) return context === 'h' ? '' : 'none';
    if (context === 'h') return ` src="${escapeAttribute(url)}"`;
    const value = cssUrl(url);
    return context === 'a' ? escapeAttribute(value) : value;
  }
  const markers = /\0([has])(\d+)\0/g;
  if (maxBytes === undefined) return output.html.replace(markers, replacement);

  let left = maxBytes, offset = 0;
  const substitutions = new Map<string, { text: string; bytes: number }>();
  function literal(start: number, end: number): boolean {
    if (end - start > left) return false;
    const size = measureHtml(output.html.slice(start, end), left);
    if (size === null) return false;
    left -= size;
    return true;
  }
  // First account for each literal and substitution. The expanded string is
  // built once, after the whole document (including repeated refs) fits.
  for (const marker of output.html.matchAll(markers)) {
    if (!literal(offset, marker.index)) return null;
    let value = substitutions.get(marker[0]);
    if (!value) {
      const text = replacement(marker[0], marker[1] as RefContext, marker[2]);
      const bytes = measureHtml(text, left);
      if (bytes === null) return null;
      substitutions.set(marker[0], value = { text, bytes });
    }
    left -= value.bytes;
    if (left < 0) return null;
    offset = marker.index + marker[0].length;
  }
  if (!literal(offset, output.html.length)) return null;
  return output.html.replace(markers, marker => substitutions.get(marker)!.text);
}
