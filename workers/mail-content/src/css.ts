import { cssUrl, isDataImage, isRemoteImageUrl } from './urls.ts';

export type CssPart = string | { url: string };
type Delimiter = ';' | '{' | '}';
interface Statement { value: string; end?: Delimiter }

// Recognize structural delimiters only outside strings, comments and functions.
// Keep escapes intact here so they cannot change where a declaration ends;
// declarations and selectors with escapes are discarded when validated below.
function statements(input: string): Statement[] | undefined {
  const result: Statement[] = [];
  let value = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\') {
      if (i + 1 === input.length) return undefined;
      value += c + input[++i];
    } else if (quote) {
      value += c;
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      value += c;
    } else if (c === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      value += ' ';
      i = end + 1;
    } else if (c === '(') {
      depth++;
      value += c;
    } else if (c === ')') {
      if (depth-- === 0) return undefined;
      value += c;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      result.push({ value: value.trim(), end: c });
      value = '';
    } else {
      value += c;
    }
  }
  if (quote || depth) return undefined;
  if (value.trim()) result.push({ value: value.trim() });
  return result;
}

// These functions operate on literal CSS values; deliberately exclude URL
// alternatives and any mechanism for substituting a property value later.
const functions = new Set(`rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix
  calc min max clamp repeat minmax fit-content
  linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient
  matrix matrix3d translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d
  rotate rotatex rotatey rotatez rotate3d skew skewx skewy perspective
  blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia
  cubic-bezier steps`.split(/\s+/));

function declarationValue(property: string, value: string): CssPart[] | undefined {
  // Do not emit literal markup delimiters into a raw-text <style> element.
  if (/[\\<>\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value)) return undefined;
  const token = /[-_a-z][\w-]*\(|"[^"\n\r\f]*"|'[^'\n\r\f]*'|[a-z0-9_-]+|[ \t\r\n\f#.,%+*/]+|\)/iy;
  const urlArgument = /\s*(?:"([^"\n\r\f]*)"|'([^'\n\r\f]*)'|([^\s"'()]+?))\s*\)/y;
  const parts: CssPart[] = [];
  let start = 0;
  let depth = 0;
  while (token.lastIndex < value.length) {
    const match = token.exec(value);
    if (!match) return undefined;
    const spelling = match[0];
    if (spelling === ')') {
      if (depth-- === 0) return undefined;
    } else if (spelling.endsWith('(')) {
      const name = spelling.slice(0, -1).toLowerCase();
      if (name === 'url') {
        urlArgument.lastIndex = token.lastIndex;
        const arg = urlArgument.exec(value);
        if (!arg) return undefined;
        const url = arg[1] ?? arg[2] ?? arg[3];
        parts.push(value.slice(start, match.index));
        if (isDataImage(url)) {
          parts.push(cssUrl(url));
        } else if ((property === 'background' || property === 'background-image') && isRemoteImageUrl(url)) {
          parts.push({ url });
        } else {
          return undefined;
        }
        start = token.lastIndex = urlArgument.lastIndex;
      } else if (functions.has(name)) {
        depth++;
      } else {
        return undefined;
      }
    }
  }
  if (depth !== 0) return undefined;
  parts.push(value.slice(start));
  return parts;
}

function declarations(items: Statement[]): CssPart[] {
  const result: CssPart[] = [];
  for (const { value: statement } of items) {
    const colon = statement.indexOf(':');
    if (colon < 0) continue;
    const property = statement.slice(0, colon).trim().toLowerCase();
    if (!/^-?[a-z][a-z\d-]*$/.test(property) || property === 'behavior' || property === '-moz-binding') continue;
    let value = statement.slice(colon + 1).trim();
    const important = /\s*!\s*important$/i.exec(value);
    if (important) value = value.slice(0, important.index).trimEnd();
    if (!value) continue;
    if (property === 'position') {
      value = value.toLowerCase();
      if (value === 'fixed' || value === 'sticky') value = 'static';
      if (!/^(?:absolute|relative|static|initial|inherit|unset|revert|revert-layer)$/.test(value)) continue;
    }
    const parts = declarationValue(property, value);
    if (!parts) continue;
    result.push(`${property}: `);
    for (const part of parts) result.push(part);
    result.push(important ? ' !important; ' : '; ');
  }
  return result;
}

function rules(items: Statement[], level = 0): CssPart[] {
  const result: CssPart[] = [];
  for (let i = 0; i < items.length; i++) {
    const { value, end } = items[i];
    if (end !== '{') continue;
    let close = i + 1;
    let depth = 1;
    for (; close < items.length; close++) {
      if (items[close].end === '{') depth++;
      if (items[close].end === '}' && --depth === 0) break;
    }
    if (close === items.length) break;
    const block = items.slice(i + 1, close + 1);
    i = close;
    const media = /^@media\s*([\w\s.:()/,%-]+)$/i.exec(value);
    if (media && level < 4) {
      // The closing brace may itself carry the last text in the block.
      const nested = rules(block.slice(0, -1), level + 1);
      if (nested.length) {
        result.push(`@media ${media[1].trim()} { `);
        for (const part of nested) result.push(part);
        result.push('} ');
      }
    } else if (value && /^[\w\s.#:*,()\[\]=+~|>-]+$/.test(value) && !block.some((item, index) =>
      item.end === '{' || (item.end === '}' && index < block.length - 1))) {
      const safe = declarations(block);
      if (safe.length) {
        result.push(`${value} { `);
        for (const part of safe) result.push(part);
        result.push('} ');
      }
    }
  }
  return result;
}

export function sanitiseCss(input: string, inline: boolean): CssPart[] {
  const items = statements(input);
  if (!items) return [];
  if (!inline) return rules(items);
  return items.every(item => item.end !== '{' && item.end !== '}') ? declarations(items) : [];
}
