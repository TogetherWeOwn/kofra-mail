import assert from 'node:assert/strict';
import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import postcss, { type Declaration } from 'postcss';

const elements = new Set('a abbr b blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins li ol p pre q s small span strike strong style sub sup table tbody td tfoot th thead tr tt u ul wbr'.split(' '));
const globalAttrs = new Set('align valign bgcolor color width height border cellpadding cellspacing colspan rowspan dir lang class style title'.split(' '));
const extras = { a: ['href', 'target', 'rel'], img: ['src', 'alt'] } as Record<string, string[] | undefined>;
const dataImage = /^data:image\/(?:png|jpeg|gif|webp)(?:;base64)?,(.*)$/i;

function checkImage(url: string, origin: string) {
  const data = dataImage.exec(url);
  if (data) {
    const size = /^data:image\/\w+;base64,/i.test(url)
      ? Buffer.from(data[1], 'base64').length
      : data[1].replace(/%[\da-f]{2}/gi, '_').length;
    assert.ok(size <= 65536, 'oversized image');
    return;
  }
  const parsed = new URL(url);
  assert.equal(parsed.origin, origin, `non-fixture image ${url}`);
  assert.match(parsed.pathname, /^\/asset\/(?:cid|img)\/\d+$/);
}

function checkCSS(css: string, origin: string, inline: boolean) {
  const sheet = postcss.parse(inline ? `p{${css}}` : css);
  sheet.walkAtRules(rule => {
    assert.equal(rule.name, 'media', `unpermitted at-rule ${rule.name}`);
    assert.ok(rule.nodes && !inline);
    assert.match(rule.params, /^[ \w.:()/,%-]+$/);
  });
  sheet.walkRules(rule => assert.doesNotMatch(rule.selector, /[<{}\\]/));
  sheet.walkComments(() => assert.fail('unexpected CSS comment'));
  sheet.walkDecls((decl: Declaration) => {
    assert.match(decl.prop, /^-?[a-z][a-z0-9-]*$/);
    assert.doesNotMatch(decl.prop, /^(?:behavior|-moz-binding)$/i);
    const decoded = decl.value.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
    assert.doesNotMatch(decoded, /\b(?:expression|image-set|image|var|attr|paint|src)\s*\(/i);
    if (decl.prop === 'position') assert.doesNotMatch(decoded, /fixed|sticky/i);
    let urls = 0;
    const rest = decl.value.replace(/\burl\("((?:\\[\da-f]{1,6} |[^"\\])*)"\)/gi, (_, contents: string) => {
      urls++;
      const url = contents.replace(/\\([\da-f]{1,6}) /gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
      if (!dataImage.test(url)) assert.match(decl.prop, /^(?:background|background-image)$/);
      checkImage(url, origin);
      return '';
    });
    assert.doesNotMatch(rest, /\burl\s*\(/i, `unparsed URL in ${decl.value} (${urls} parsed)`);
  });
}

export function checkOutput(html: string, origin = 'https://content.example') {
  const allowWrapper = new Set(['html', 'head', 'body']);
  const root = parse(html, { scriptingEnabled: true });
  const anchors: string[] = [];
  const images: string[] = [];
  const tags: string[] = [];
  const text: string[] = [];
  let metas = 0;
  let doctypes = 0;
  function visit(node: Tree.ChildNode, parent?: Tree.Element) {
    if (node.nodeName === '#comment') assert.fail('comment survived');
    if (node.nodeName === '#documentType' && 'name' in node) {
      assert.equal(node.name, 'html');
      assert.equal(++doctypes, 1);
    }
    if (node.nodeName === '#text' && 'value' in node && parent?.tagName !== 'style') text.push(node.value);
    if (!('tagName' in node)) return;
    const { tagName, attrs } = node;
    tags.push(tagName);
    assert.equal(node.namespaceURI, 'http://www.w3.org/1999/xhtml');
    if (tagName === 'meta') {
      assert.deepEqual(attrs, [{ name: 'charset', value: 'utf-8' }]);
      assert.equal(parent?.tagName, 'head');
      assert.equal(++metas, 1);
    } else if (allowWrapper.has(tagName)) {
      assert.deepEqual(attrs, []);
    } else {
      assert.ok(elements.has(tagName), `unpermitted element ${tagName}`);
      const attr = (name: string) => attrs.find(a => a.name === name)?.value;
      for (const { name, value, namespace } of attrs) {
        assert.equal(namespace, undefined);
        assert.ok(globalAttrs.has(name) || extras[tagName]?.includes(name), `unpermitted ${tagName}[${name}]`);
        if (name === 'style') checkCSS(value, origin, true);
      }
      if (tagName === 'a') {
        assert.equal(attr('target'), '_blank');
        assert.equal(attr('rel'), 'noopener noreferrer');
        const href = attr('href');
        if (href !== undefined) {
          assert.match(href, /^(?:https?|mailto):/i);
          assert.ok(['https:', 'http:', 'mailto:'].includes(new URL(href).protocol));
          anchors.push(href);
        }
      }
      if (tagName === 'img' && attr('src') !== undefined) {
        checkImage(attr('src')!, origin);
        images.push(attr('src')!);
      }
      if (tagName === 'style') {
        const css = node.childNodes.map(child => {
          assert.ok('value' in child);
          return child.value;
        }).join('');
        checkCSS(css, origin, false);
      }
    }
    for (const child of node.childNodes) visit(child, node);
  }
  for (const node of root.childNodes) visit(node);
  assert.equal(metas, 1, 'missing wrapper meta');
  assert.equal(doctypes, 1, 'missing wrapper doctype');
  return { anchors, images, tags, text: text.join('') };
}
