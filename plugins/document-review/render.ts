import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import type { Root, Element, RootContent, Text } from 'hast';
import type { Change, Comment } from './model';

export type Mark = { start: number; end: number; kind: 'ins' | 'del' | 'accepted' | 'rejected' | 'comment'; id: string };
export function reviewDocument(base: string, changes: Change[]): { text: string; marks: Mark[] } {
  let text = '', offset = 0;
  const marks: Mark[] = [];
  const add = (value: string, kind: Mark['kind'], id: string) => {
    const start = text.length; text += value; marks.push({ start, end: text.length, kind, id });
  };
  for (const c of changes) {
    text += base.slice(offset, c.start);
    if (c.decision === 'pending') { add(c.before, 'del', c.id); add(c.after, 'ins', c.id); }
    else add(c.decision === 'accepted' ? c.after : c.before, c.decision, c.id);
    offset = c.end;
  }
  text += base.slice(offset); return { text, marks };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
function span(text: string, from: number, to: number, exact: boolean, marks: Mark[]): Element {
  const active = marks.filter(m => m.start < to && m.end > from);
  const change = active.find(m => m.kind !== 'comment');
  return { type: 'element', tagName: change?.kind === 'del' ? 'del' : change?.kind === 'ins' ? 'ins' : 'span', properties: {
    'data-source-start': from, 'data-source-end': to, 'data-exact': String(exact),
    ...(change ? { 'data-change-id': change.id, className: [`dr-${change.kind}`] } : {}),
    ...(active.some(m => m.kind === 'comment') ? { 'data-comment-id': active.find(m => m.kind === 'comment')!.id, className: [...(change ? [`dr-${change.kind}`] : []), 'dr-highlight'] } : {}),
  }, children: [{ type: 'text', value: text }] };
}
export function renderMarkdown(source: string, marks: Mark[] = [], plain = false): string {
  const tree = (plain ? { type: 'root', children: [{ type: 'element', tagName: 'pre', properties: { className: ['dr-plain'] }, children: [{ type: 'text', value: source, position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: source.length } } }] }] } : parser.runSync(parser.parse(source))) as Root;
  function walk(parent: Root | Element) {
    const next: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type === 'element') {
        // Raw HTML is never enabled. Also refuse active URLs and remote images.
        if (node.tagName === 'a') {
          const href = String(node.properties.href ?? '');
          if (!/^(https?:|mailto:|#)/i.test(href)) delete node.properties.href;
          node.properties.rel = ['noopener', 'noreferrer']; node.properties.target = '_blank';
        }
        if (node.tagName === 'img') {
          next.push({ type: 'text', value: `[Image: ${String(node.properties.alt ?? '')}]` }); continue;
        }
        const from = node.position?.start.offset, to = node.position?.end.offset;
        if (from !== undefined && to !== undefined) {
          node.properties['data-source-start'] = from; node.properties['data-source-end'] = to;
          if (marks.some(m => m.kind !== 'comment' && m.start < to && m.end > from)) node.properties['data-has-change'] = 'true';
        }
        walk(node); next.push(node);
      } else if (node.type === 'text') {
        const from = node.position?.start.offset, to = node.position?.end.offset;
        if (from === undefined || to === undefined) { next.push(node); continue; }
        const exact = source.slice(from, to) === node.value;
        if (!exact) { next.push(span(node.value, from, to, false, marks)); continue; }
        const cuts = [...new Set([from, to, ...marks.flatMap(m => [m.start, m.end]).filter(p => p > from && p < to)])].sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) next.push(span(source.slice(cuts[i], cuts[i + 1]), cuts[i]!, cuts[i + 1]!, true, marks));
      } else if (node.type !== 'raw') next.push(node);
    }
    parent.children = next as typeof parent.children;
  }
  walk(tree); return toHtml(tree);
}
export function commentMarks(comments: Comment[]): Mark[] {
  return comments.filter(c => c.status !== 'resolved' && c.anchor && !c.anchor.orphaned).map(c => ({ start: c.anchor!.start, end: c.anchor!.end, kind: 'comment', id: c.id }));
}

/** Map a rich-text selection to exact Markdown source positions. Escaped text,
 * code blocks and entities conservatively select their containing source node. */
export function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const endpoint = (node: Node, offset: number, end: boolean) => {
    const element = (node.nodeType === 1 ? node as ElementOfDOM : node.parentElement)?.closest<HTMLElement>('[data-source-start]');
    if (!element || !root.contains(element)) return null;
    if (element.dataset.exact === 'true') {
      const prefix = root.ownerDocument.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset);
      return Number(element.dataset.sourceStart) + prefix.toString().length;
    }
    return Number(end ? element.dataset.sourceEnd : element.dataset.sourceStart);
  };
  const start = endpoint(range.startContainer, range.startOffset, false), end = endpoint(range.endContainer, range.endOffset, true);
  return start !== null && end !== null && end > start ? { start, end } : null;
}
type ElementOfDOM = HTMLElement;
