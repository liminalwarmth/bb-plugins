import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { computeChanges as diffForHtml } from './model';
import { targetLabel } from './comment-target';
import type { Anchor, ElementReference } from './model';

export const isHtml = (path: string) => /\.html?$/i.test(path);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const blocked = new Set(['script', 'iframe', 'object', 'embed', 'base']);
export const attr = (el: Tree.Element, name: string) => el.attrs.find(a => a.name === name)?.value ?? '';
const isElement = (node: Tree.Node): node is Tree.Element => 'tagName' in node;
function descriptor(el: Tree.Element): string {
  return `${el.tagName}${attr(el, 'id') ? `#${attr(el, 'id')}` : ''}${attr(el, 'aria-label') ? ` (${attr(el, 'aria-label')})` : ''}`.slice(0, 300);
}
function selector(el: Tree.Element, positions: WeakMap<Tree.Node, number>): string {
  const parts: string[] = []; let node: Tree.Element | null = el;
  while (node && parts.length < 30) {
    parts.unshift(`${node.tagName}:nth-of-type(${positions.get(node) ?? 1})`);
    node = node.parentNode && isElement(node.parentNode) ? node.parentNode : null;
  }
  return parts.join(' > ').slice(0, 2000);
}
export type HtmlTarget = { key: string; start: number; end: number; element: ElementReference };
export function parseHtml(source: string) {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const targets: HtmlTarget[] = [], positions = new WeakMap<Tree.Node, number>(), texts = new WeakMap<Tree.Node, string>();
  // Bounded text summaries and sibling indices are built once, instead of
  // rescanning every sibling/subtree for every annotation target.
  function index(node: Tree.Node): string {
    if (node.nodeName === '#text') return norm((node as Tree.TextNode).value).slice(0, 1000);
    let summary = ''; const counts = new Map<string, number>();
    if ('childNodes' in node) for (const child of node.childNodes) {
      if (isElement(child)) { const n = (counts.get(child.tagName) ?? 0) + 1; counts.set(child.tagName, n); positions.set(child, n); }
      const value = index(child);
      if (summary.length < 1000 && value) summary = `${summary}${summary ? ' ' : ''}${value}`.slice(0, 1000);
    }
    if (isElement(node) && ['style', 'script', 'template', 'noscript'].includes(node.tagName)) summary = '';
    texts.set(node, summary); return summary;
  }
  index(tree);
  const walk = (node: Tree.Node) => {
    if (isElement(node) && !blocked.has(node.tagName) && !['head', 'meta', 'link', 'style', 'title', 'template'].includes(node.tagName)) {
      const loc = node.sourceCodeLocation;
      // Implicit body nodes in fragments still provide a page/background target.
      const start = loc?.startOffset ?? 0, end = loc?.endOffset ?? source.length;
      if (loc || node.tagName === 'body') {
        const ancestors: string[] = []; let parent = node.parentNode;
        while (parent && isElement(parent) && ancestors.length < 8) { ancestors.unshift(descriptor(parent)); parent = parent.parentNode; }
        const attributes = Object.fromEntries(node.attrs.filter(a => ['id', 'class', 'role', 'aria-label', 'alt', 'title', 'src', 'href', 'data-testid'].includes(a.name)).map(a => [a.name, a.value.slice(0, 1000)]));
        const key = `${node.tagName}_${start}`;
        targets.push({ key, start, end, element: { format: 'html', tag: node.tagName, selector: selector(node, positions), attributes, text: texts.get(node) ?? '', html: source.slice(start, Math.min(end, start + 3000)), ancestors } });
        node.attrs = node.attrs.filter(a => !a.name.startsWith('data-dr-'));
        node.attrs.push({ name: 'data-dr-node', value: key });
      }
    }
    if ('childNodes' in node && !(isElement(node) && blocked.has(node.tagName))) node.childNodes.forEach(walk);
  };
  walk(tree);
  const counts = new Map<string, number>();
  for (const t of targets) for (const key of ['id', 'data-testid', 'text'] as const) {
    const value = key === 'text' ? t.element.text : t.element.attributes[key]; if (value) { const k = `${t.element.tag}:${key}:${value}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  }
  for (const t of targets) {
    t.element.uniqueKeys = (['id', 'data-testid'] as const).filter(key => !!t.element.attributes[key] && counts.get(`${t.element.tag}:${key}:${t.element.attributes[key]}`) === 1);
    t.element.uniqueText = !!t.element.text && counts.get(`${t.element.tag}:text:${t.element.text}`) === 1;
  }
  return { tree, targets };
}
export function makeHtmlAnchor(source: string, key: string, point?: ElementReference['point'], selectedText?: string, pointer?: ElementReference['pointer'], textRange?: ElementReference['textRange'], targets = parseHtml(source).targets): Anchor {
  const target = targets.find(t => t.key === key);
  if (!target) throw new Error('That element changed. Right-click it again to attach your comment.');
  const hit = pointer ? targets.find(t => t.start === pointer.hit.sourceStart && t.element.tag === pointer.hit.tag) : undefined;
  if (pointer && !hit) throw new Error('The element under the pointer changed. Select it again.');
  const canonicalPointer = pointer && hit ? { ...pointer, hit: { ...pointer.hit, tag: hit.element.tag, selector: hit.element.selector, sourceStart: hit.start, sourceEnd: hit.end, text: hit.element.text, html: hit.element.html, attributes: hit.element.attributes } } : undefined;
  return { start: target.start, end: target.end, quote: (selectedText || (target.element.tag === 'body' ? 'Page background' : '') || target.element.text || target.element.attributes['aria-label'] || target.element.attributes.alt || `<${target.element.tag}>`).slice(0, 2000), prefix: source.slice(Math.max(0, target.start - 80), target.start), suffix: source.slice(target.end, target.end + 80), orphaned: false, element: { ...target.element, ...(point ? { point } : {}), ...(selectedText ? { selectedText: selectedText.slice(0, 2000) } : {}), ...(canonicalPointer ? { pointer: canonicalPointer } : {}), ...(textRange ? { textRange } : {}) } };
}
export function findHtmlTarget(anchor: Anchor, targets: HtmlTarget[], mappedStart?: number): HtmlTarget | undefined {
  const ref = anchor.element; if (!ref || ref.format !== 'html') return undefined;
  const candidates = targets.filter(t => t.element.tag === ref.tag);
  if (ref.tag === 'body' && candidates.length === 1) return candidates[0];
  for (const key of ['id', 'data-testid']) {
    const id = ref.attributes[key];
    if (id && (!ref.uniqueKeys || ref.uniqueKeys.includes(key as 'id' | 'data-testid'))) { const hits = candidates.filter(t => t.element.attributes[key] === id); if (hits.length === 1) return hits[0]; }
  }
  if (mappedStart !== undefined) {
    const mapped = candidates.filter(t => t.start === mappedStart && t.element.selector === ref.selector && JSON.stringify(t.element.attributes) === JSON.stringify(ref.attributes));
    if (mapped.length === 1) return mapped[0];
  }
  const semantic = candidates.filter(t => (ref.uniqueText !== false && ref.text && t.element.text === ref.text) || (ref.attributes['aria-label'] && t.element.attributes['aria-label'] === ref.attributes['aria-label']) || (ref.attributes.alt && t.element.attributes.alt === ref.attributes.alt));
  if (semantic.length === 1) return semantic[0];
  if (semantic.length > 1) {
    const contextual = semantic.filter(t => t.element.ancestors.join('/') === ref.ancestors.join('/'));
    if (contextual.length === 1) return contextual[0];
    return undefined;
  }
  // Empty design regions have no text. Require a unique structural fingerprint,
  // including source attributes and enclosing section; never use a screen pixel.
  if (!ref.text) {
    const hits = candidates.filter(t => !t.element.text && JSON.stringify(t.element.attributes) === JSON.stringify(ref.attributes) && t.element.ancestors.join('/') === ref.ancestors.join('/'));
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}
export function reanchorHtml(anchor: Anchor, source: string, targets = parseHtml(source).targets, mappedStart?: number): Anchor {
  const target = findHtmlTarget(anchor, targets, mappedStart);
  if (!target) return { ...anchor, orphaned: true };
  const current = makeHtmlAnchorFromTarget(source, target, anchor);
  return { ...current, quote: anchor.quote };
}
function makeHtmlAnchorFromTarget(source: string, target: HtmlTarget, previous: Anchor): Anchor {
  return { ...previous, start: target.start, end: target.end, orphaned: false, removed: false, prefix: source.slice(Math.max(0, target.start - 80), target.start), suffix: source.slice(target.end, target.end + 80), element: { ...target.element, ...(previous.element?.point ? { point: previous.element.point } : {}), ...(previous.element?.selectedText ? { selectedText: previous.element.selectedText } : {}), ...(previous.element?.pointer ? { pointer: previous.element.pointer } : {}), ...(previous.element?.textRange && target.element.text === previous.element.text ? { textRange: previous.element.textRange } : {}) } };
}
export function assetReference(ref: string, id: string, base = ''): string {
  const raw = ref.trim();
  if (!raw || raw.startsWith('#') || /^(?:https?:|data:|blob:)/i.test(raw)) return raw;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(raw)) return '';
  return `/api/v1/plugins/document-review/http/asset?id=${encodeURIComponent(id)}&path=${encodeURIComponent(base + raw)}`;
}
export function rewriteCss(source: string, id: string, base = ''): string {
  return source.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (_all, _q, url) => `url("${assetReference(url, id, base).replaceAll('"', '%22')}")`).replace(/@import\s+(['"])([^'"]+)\1/gi, (_all, _q, url) => `@import "${assetReference(url, id, base).replaceAll('"', '%22')}"`);
}
export function htmlPreview(source: string, id: string, options: { interactive?: boolean; bridge?: string; assetOrigin?: string } = {}): { html: string; targets: HtmlTarget[]; scriptsDisabled: boolean } {
  const { tree, targets } = parseHtml(source);
  let scriptsDisabled = false;
  function clean(parent: Tree.ParentNode) {
    if (parent.childNodes.some(n => isElement(n) && n.tagName === 'script')) scriptsDisabled = true;
    parent.childNodes = parent.childNodes.filter(node => !(isElement(node) && ((blocked.has(node.tagName) && !(options.interactive && node.tagName === 'script')) || (node.tagName === 'meta' && attr(node, 'http-equiv')))));
    for (const node of parent.childNodes) if (isElement(node)) {
      if (node.attrs.some(a => /^on[a-z]/i.test(a.name))) scriptsDisabled = true;
      node.attrs = node.attrs.filter(a => (options.interactive || !/^on/i.test(a.name)) && !['srcdoc', 'autofocus', 'nonce', 'integrity'].includes(a.name) && !/^(?:javascript|vbscript):/i.test(a.value.trim()));
      for (const a of node.attrs) {
        if (['src', 'poster'].includes(a.name) || (node.tagName === 'link' && a.name === 'href')) a.value = assetReference(a.value, id);
        if (a.name === 'style') a.value = rewriteCss(a.value, id);
      }
      node.attrs = node.attrs.filter(a => a.name !== 'srcset');
      if (node.tagName === 'style') for (const t of node.childNodes) if (t.nodeName === '#text') (t as Tree.TextNode).value = rewriteCss((t as Tree.TextNode).value, id);
      clean(node);
    }
  }
  clean(tree);
  const head = tree.childNodes.find(n => isElement(n) && n.tagName === 'html');
  const headNode = head && isElement(head) ? head.childNodes.find(n => isElement(n) && n.tagName === 'head') : undefined;
  if (headNode && isElement(headNode)) {
    const origin = options.assetOrigin && /^https?:\/\//.test(options.assetOrigin) ? new URL(options.assetOrigin).origin : "'self'";
    const scriptPolicy = options.interactive ? `'unsafe-inline' https: ${origin}` : "'none'";
    const injected = parseFragment(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptPolicy}; style-src 'unsafe-inline' https: 'self' ${origin}; img-src data: blob: https: 'self' ${origin}; font-src data: https: 'self' ${origin}; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'"><meta name="referrer" content="no-referrer">${options.interactive && options.bridge ? `<script>${options.bridge}</script>` : ''}`);
    headNode.childNodes.unshift(...injected.childNodes);
  }
  return { html: serialize(tree), targets, scriptsDisabled: scriptsDisabled && !options.interactive };
}

const visualDiffs = new WeakMap<import('./model').Change, { before: string; after: string; edits: import('./model').Change[] }>();
/** Preview decoration has a short budget; a wholesale outline is a safe fallback. */
export function visualHtmlChanges(change: import('./model').Change) {
  const cached = visualDiffs.get(change);
  if (cached?.before === change.before && cached.after === change.after) return cached.edits;
  const edits = diffForHtml(change.before, change.after, 24);
  visualDiffs.set(change, { before: change.before, after: change.after, edits }); return edits;
}

function labelForHtml(t: HtmlTarget): string {
  return t.element.tag === 'html' ? 'page layout' : targetLabel({ start: t.start, end: t.end, quote: t.element.text, prefix: '', suffix: '', orphaned: false, element: t.element });
}
/** Human descriptions of an atomic source update; raw code stays collapsed. */
export function describeHtmlUpdate(content: string, change: import('./model').Change): string[] {
  const current = parseHtml(content).targets;
  const original = content.slice(0, change.start) + change.before + content.slice(change.end);
  const before = parseHtml(original).targets;
  const labels = new Set<string>();
  const identities = new Set(current.flatMap(t => (['id', 'data-testid'] as const).filter(k => !!t.element.attributes[k]).map(k => `${t.element.tag}:${k}:${t.element.attributes[k]}`)));
  for (const t of before) {
    const key = t.element.uniqueKeys?.find(k => !identities.has(`${t.element.tag}:${k}:${t.element.attributes[k]}`));
    if (key) labels.add(`Removed: ${labelForHtml(t)}`);
    if (labels.size >= 4) break;
  }
  let delta = 0;
  for (const e of visualHtmlChanges(change).slice(0, 100)) {
    const start = change.start + e.start + delta, end = start + e.after.length;
    delta += e.after.length - (e.end - e.start);
    const t = current.filter(t => !['span', 'strong', 'em', 'i', 'b'].includes(t.element.tag) && t.start <= start && t.end >= end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (t) labels.add(`Changed: ${labelForHtml(t)}`);
    if (labels.size >= 4) break;
  }
  return [...labels].slice(0, 4);
}
