import { Node as TiptapNode, mergeAttributes, type JSONContent } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { diffChars } from 'diff';
import { serializeSource } from './markdown-source';
import { mapOffset } from './review-state';
import type { Change } from './model';

export type Md = { type: string; value?: string; children?: Md[]; position?: { start: { offset: number }; end: { offset: number } }; [key: string]: any };
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']);
const key = (node: PMNode) => JSON.stringify(node.toJSON());
export const RawMarkdown = TiptapNode.create({ name: 'rawMarkdown', group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseHTML: () => [{ tag: 'pre[data-raw-markdown]' }],
  renderHTML: ({ HTMLAttributes }) => ['pre', mergeAttributes(HTMLAttributes, { 'data-raw-markdown': 'true', class: 'dr-raw-block' }), ['code', 0]],
});
export const MarkdownImage = TiptapNode.create({ name: 'image', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, title: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-markdown-image]' }],
  renderHTML: ({ node }) => ['span', { 'data-markdown-image': 'true', class: 'dr-image', title: node.attrs.src }, `[Image: ${node.attrs.alt || node.attrs.src}]`],
});
export interface SourceRun { sourceStart: number; sourceEnd: number; from: number; to: number; raw: string; value: string; edits: Change[] }
export interface MarkdownDocument { source: string; doc: PMNode; blocks: { start: number; end: number; key: string; syntax: Md }[]; runs: SourceRun[] }
function charEdits(raw: string, value: string): Change[] {
  if (raw === value) return [];
  const parts = diffChars(raw, value, { timeout: 80 });
  if (!parts) return [{ id: '', start: 0, end: raw.length, before: raw, after: value, decision: 'pending' }];
  const edits: Change[] = []; let offset = 0;
  for (let i = 0; i < parts.length;) {
    const p = parts[i]!; if (!p.added && !p.removed) { offset += p.value.length; i++; continue; }
    const start = offset; let before = '', after = '';
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) { const v = parts[i++]!; if (v.removed) { before += v.value; offset += v.value.length; } if (v.added) after += v.value; }
    edits.push({ id: '', start, end: offset, before, after, decision: 'pending' });
  }
  return edits;
}
export function parseMarkdown(source: string, schema: Schema, plain = false, renderedDoc?: PMNode): MarkdownDocument {
  const tree = markdown.parse(source) as unknown as Md;
  // GFM accepts pipe-less continuation lines as rows. Template directives and
  // adjacent literal text belong to the source, never to synthesized table cells.
  const protectTableTails = (parent: Md) => {
    parent.children = parent.children?.flatMap(n => {
      if (n.type !== 'table') { protectTableTails(n); return [n]; }
      const rows = n.children ?? [], split = rows.findIndex((r, i) => i > 0 && !/(?<!\\)\|/.test(source.slice(r.position!.start.offset, r.position!.end.offset)));
      if (split < 0) return [n];
      const tail: Md = { type: 'reviewLiteral', position: { start: rows[split]!.position!.start, end: n.position!.end } };
      n.children = rows.slice(0, split); n.position = { start: n.position!.start, end: rows[split - 1]!.position!.end };
      return [n, tail];
    });
  }; protectTableTails(tree);
  const definitions = new Map<string, Md>();
  const findDefinitions = (n: Md) => { if (n.type === 'definition') definitions.set(n.identifier, n); n.children?.forEach(findDefinitions); }; findDefinitions(tree);
  const leaves: { value: string; start: number; end: number }[] = [];
  const text = (value: string, node: Md, marks: JSONContent['marks'] = []): JSONContent[] => {
    if (!value) return [];
    leaves.push({ value, start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 });
    return [{ type: 'text', text: value, ...(marks.length ? { marks } : {}) }];
  };
  const inline = (nodes: Md[], marks: NonNullable<JSONContent['marks']> = []): JSONContent[] => nodes.flatMap(n => {
    if (n.type === 'text') return text(n.value ?? '', n, marks);
    if (n.type === 'inlineCode') return text(n.value ?? '', n, [...marks, { type: 'code' }]);
    if (n.type === 'break') return [{ type: 'hardBreak' }];
    if (n.type === 'image' || n.type === 'imageReference') { const d = n.type === 'imageReference' ? definitions.get(n.identifier) : n; return [{ type: 'image', attrs: { src: d?.url ?? '', alt: n.alt ?? '', title: d?.title ?? null } }]; }
    const type = ({ strong: 'bold', emphasis: 'italic', delete: 'strike', link: 'link', linkReference: 'link' } as Record<string, string>)[n.type];
    if (type) { const d = n.type === 'linkReference' ? definitions.get(n.identifier) : n; return inline(n.children ?? [], [...marks, { type, ...(type === 'link' ? { attrs: { href: (!/^[a-z][a-z\d+.-]*:/i.test(d?.url ?? '') || /^(https?:|mailto:)/i.test(d?.url ?? '')) ? d!.url : '', title: d?.title ?? null } } : {}) }]); }
    return text(source.slice(n.position?.start.offset, n.position?.end.offset), n, marks);
  });
  const renderedInline: PMNode[] = [];
  renderedDoc?.descendants(n => { if (n.type.name === 'paragraph' || n.type.name === 'heading') renderedInline.push(n); });
  let inlineIndex = 0;
  const inlineBlock = (n: Md, type: 'paragraph' | 'heading' = 'paragraph', attrs?: Record<string, unknown>): JSONContent => {
    const firstLeaf = leaves.length;
    let content = inline(n.children ?? []);
    const rendered = renderedInline[inlineIndex++];
    if (rendered?.type.name === type) {
      const visible = schema.nodeFromJSON({ type, attrs, content }).textContent, actual = rendered.textContent;
      if (!n.children?.length && /^[ \t]+$/.test(actual) && n.type === 'tableCell') {
        const emptyAt = n.position!.start.offset + (source.slice(n.position!.start.offset, n.position!.end.offset).match(/^\|?[ \t]*/)?.[0].length ?? 0);
        if (source.slice(emptyAt - actual.length, emptyAt) === actual) {
          n.children = [{ type: 'text', value: actual, position: { start: { offset: emptyAt - actual.length }, end: { offset: emptyAt } } }];
          leaves.length = firstLeaf; content = inline(n.children);
          return { type, ...(attrs ? { attrs } : {}), content };
        }
      }
      const start = actual.indexOf(visible), prefix = start < 0 ? '' : actual.slice(0, start), suffix = start < 0 ? '' : actual.slice(start + visible.length);
      // Markdown trims paragraph edges and table padding. Preserve the literal
      // spaces actually present in the live editor, without claiming untouched
      // source padding or duplicating a space on the next keystroke.
      if (start >= 0 && /^[ \t]*$/.test(prefix + suffix) && (prefix || suffix) && n.children?.length) {
        const first = n.children[0]!, last = n.children.at(-1)!, before = first.position!.start.offset, after = last.position!.end.offset;
        if (source.slice(before - prefix.length, before) === prefix && source.slice(after, after + suffix.length) === suffix) {
          if (prefix) { const pos = { start: { offset: before - prefix.length }, end: { offset: before } }; n.children.unshift({ type: 'text', value: prefix, position: pos }); if (type === 'paragraph' && n.type === 'paragraph') n.position = { start: pos.start, end: n.position!.end }; }
          if (suffix) n.children.push({ type: 'text', value: suffix, position: { start: { offset: after }, end: { offset: after + suffix.length } } });
          // Coalesce text leaves just as the ProseMirror schema does.
          n.children = n.children.reduce<Md[]>((out, child) => { const previous = out.at(-1); if (previous?.type === 'text' && child.type === 'text' && previous.position!.end.offset === child.position!.start.offset) { previous.value = (previous.value ?? '') + (child.value ?? ''); previous.position = { start: previous.position!.start, end: child.position!.end }; } else out.push(child); return out; }, []);
          leaves.length = firstLeaf; content = inline(n.children);
        }
      }
    }
    return { type, ...(attrs ? { attrs } : {}), content };
  };
  const block = (n: Md): JSONContent => {
    const children = () => (n.children ?? []).map(block);
    if (n.type === 'paragraph' || n.type === 'heading') return inlineBlock(n, n.type === 'heading' ? 'heading' : 'paragraph', n.type === 'heading' ? { level: n.depth } : undefined);
    if (n.type === 'blockquote') return { type: 'blockquote', content: children() };
    if (n.type === 'list') {
      const tasks = !n.ordered && (n.children ?? []).some(c => c.checked !== null && c.checked !== undefined);
      return { type: tasks ? 'taskList' : n.ordered ? 'orderedList' : 'bulletList', ...(n.ordered ? { attrs: { start: n.start ?? 1 } } : {}), content: (n.children ?? []).map(c => ({ type: tasks ? 'taskItem' : 'listItem', ...(tasks ? { attrs: { checked: c.checked ?? false } } : {}), content: (c.children ?? []).map(block) })) };
    }
    if (n.type === 'code') return { type: 'codeBlock', attrs: { language: n.lang ?? null }, content: text(n.value ?? '', n) };
    if (n.type === 'thematicBreak') return { type: 'horizontalRule' };
    if (n.type === 'table') return { type: 'table', content: (n.children ?? []).map((r, ri) => {
      const width = n.align?.length ?? n.children?.[0]?.children?.length ?? 1;
      const cells = Array.from({ length: width }, (_, ci) => r.children?.[ci] ?? { type: 'tableCell', children: [], position: { start: r.position!.end, end: r.position!.end } });
      // Match GFM's rectangular rendered table up front, avoiding table-plugin
      // normalization transactions that would otherwise look like user edits.
      r.children = cells;
      return { type: 'tableRow', content: cells.map((c, ci) => ({ type: ri === 0 ? 'tableHeader' : 'tableCell', attrs: { markdownAlign: n.align?.[ci] ?? null }, content: [inlineBlock(c)] })) };
    }) };
    const raw = source.slice(n.position?.start.offset, n.position?.end.offset);
    return { type: 'rawMarkdown', content: text(raw, n) };
  };
  if (!plain && !tree.children?.length && renderedInline[0]?.type.name === 'paragraph' && /^[ \t]+$/.test(renderedInline[0].textContent) && source.startsWith(renderedInline[0].textContent)) {
    const value = renderedInline[0].textContent, position = { start: { offset: 0 }, end: { offset: value.length } };
    tree.children = [{ type: 'paragraph', position, children: [{ type: 'text', value, position }] }];
  }
  const nodes = plain ? [{ type: 'rawMarkdown', content: text(source, { type: 'text', position: { start: { offset: 0 }, end: { offset: source.length } } }) }] : (tree.children ?? []).map(block);
  const doc = schema.nodeFromJSON({ type: 'doc', content: nodes.length ? nodes : [{ type: 'paragraph' }] });
  const pmText: { start: number; end: number; from: number }[] = []; let count = 0;
  (renderedDoc ?? doc).descendants((n, pos) => { if (n.isText) { pmText.push({ start: count, end: count + n.text!.length, from: pos }); count += n.text!.length; } });
  const posAt = (at: number, end: boolean) => {
    const found = pmText.find(p => end ? at > p.start && at <= p.end : at >= p.start && at < p.end) ?? pmText.at(-1);
    return found ? found.from + Math.max(0, Math.min(at - found.start, found.end - found.start)) : 1;
  };
  let cumulative = 0;
  const runs = leaves.map(l => { const from = posAt(cumulative, false); cumulative += l.value.length; const to = posAt(cumulative, true), raw = source.slice(l.start, l.end); return { sourceStart: l.start, sourceEnd: l.end, from, to, raw, value: l.value, edits: charEdits(raw, l.value) }; });
  return { source, doc, runs, blocks: plain ? [{ start: 0, end: source.length, key: key(doc.child(0)), syntax: { type: 'reviewLiteral', position: { start: { offset: 0 }, end: { offset: source.length } } } }] : (tree.children?.length ? tree.children.map((n, i) => ({ start: n.position!.start.offset, end: n.position!.end.offset, key: key(doc.child(i)), syntax: n })) : [{ start: 0, end: 0, key: key(doc.child(0)), syntax: { type: 'paragraph', children: [], position: { start: { offset: 0 }, end: { offset: 0 } } } }]) };
}
export function sourceToPosition(document: MarkdownDocument, offset: number, bias: -1 | 1 = 1): number {
  const run = document.runs.find(r => offset >= r.sourceStart && offset <= r.sourceEnd);
  if (run) return Math.min(run.to, Math.max(run.from, run.from + mapOffset(offset - run.sourceStart, run.edits, bias)));
  const right = document.runs.find(r => r.sourceStart > offset), left = [...document.runs].reverse().find(r => r.sourceEnd < offset);
  return bias > 0 ? right?.from ?? left?.to ?? 1 : left?.to ?? right?.from ?? 1;
}
export function positionToSource(document: MarkdownDocument, position: number, bias: -1 | 1 = 1): number {
  const run = document.runs.find(r => bias > 0 ? position >= r.from && position < r.to : position > r.from && position <= r.to);
  if (run) {
    const inverse = run.edits.map((e, i) => { const start = e.start + run.edits.slice(0, i).reduce((d, p) => d + p.after.length - (p.end - p.start), 0); return { ...e, start, end: start + e.after.length, before: e.after, after: e.before }; });
    return run.sourceStart + mapOffset(position - run.from, inverse, bias);
  }
  const right = document.runs.find(r => r.from >= position), left = [...document.runs].reverse().find(r => r.to <= position);
  return bias > 0 ? right?.sourceStart ?? left?.sourceEnd ?? 0 : left?.sourceEnd ?? right?.sourceStart ?? document.source.length;
}
export function serializeMarkdown(doc: PMNode, original: MarkdownDocument, plain = false): string {
  if (plain) return doc.textContent;
  return serializeSource(doc, original);
}
