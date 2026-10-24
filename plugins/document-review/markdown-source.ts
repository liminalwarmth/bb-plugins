/** Lossless rich editing: reuse original syntax and patch only changed nodes.
 * Canonical Markdown generation is reserved for genuinely new structures. */
import type { Node as PMNode, Mark } from '@tiptap/pm/model';
import { diffArrays, diffChars } from 'diff';
import { decodeHTMLStrict } from 'entities';
import type { MarkdownDocument, Md } from './markdown-editor';

type Patch = { start: number; end: number; text: string };
type Unit = { value: string; marks: readonly Mark[]; raw?: string; node?: PMNode; old?: number };
type Style = { mark: string; start: number; end: number; open: string; close: string };
type Reuse = { start: number; end: number; raw: string; inherited: readonly Mark[] };
const nodes = (n: PMNode) => { const out: PMNode[] = []; n.forEach(c => out.push(c)); return out; };
const signature = (m: Mark) => JSON.stringify(m.toJSON());
const sameMarks = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m, i) => m.eq(b[i]!));
const apply = (source: string, patches: Patch[]) => {
  let end = source.length;
  for (const p of [...patches].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (p.start < 0 || p.end < p.start || p.end > end) throw new Error('Overlapping Markdown source edits. Switch to Raw to edit this structure.');
    source = source.slice(0, p.start) + p.text + source.slice(p.end); end = p.start;
  }
  return source;
};
function flatten(node: PMNode): Unit[] {
  return nodes(node).flatMap(n => n.isText ? n.text!.split('').map(value => ({ value, marks: n.marks })) : [{ value: '\0' + JSON.stringify(n.toJSON()), marks: n.marks, node: n }]);
}
/** Decode only for alignment. Raw entities, escapes and line endings remain the
 * output for every unchanged character. New text never gets entity-serialized. */
function rawUnits(raw: string, value: string, literal = false): string[] {
  if (raw === value) return raw.split('');
  const decoded: { value: string; raw: string }[] = [];
  for (let i = 0; i < raw.length;) {
    let token = raw[i]!, text = token;
    if (raw.slice(i, i + 2) === '\r\n') { token = '\r\n'; text = '\n'; }
    else if (!literal && token === '\\' && /[!-/:-@\[-`{-~]/.test(raw[i + 1] ?? '')) { token = raw.slice(i, i + 2); text = token[1]!; }
    else if (!literal && token === '&') { const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/.exec(raw.slice(i))?.[0]; if (entity) { token = entity; text = decodeHTMLStrict(entity); } }
    text.split('').forEach((value, index) => decoded.push({ value, raw: index === 0 ? token : '' })); i += token.length;
  }
  const result: string[] = []; let at = 0, gap = '';
  for (const part of diffArrays(decoded.map(c => c.value), value.split(''), { timeout: 80 }) ?? []) {
    if (part.removed) { gap += decoded.slice(at, at + part.value.length).map(c => c.raw).join(''); at += part.value.length; }
    else if (part.added) { for (const char of part.value) { result.push(gap + char); gap = ''; } }
    else for (let i = 0; i < part.value.length; i++) { const c = decoded[at++]!; if (gap && result.at(-1)?.includes('\n')) { result[result.length - 1] += gap; gap = ''; } result.push(gap + c.raw); gap = ''; }
  }
  if (gap && result.length) result[result.length - 1] += gap;
  return result;
}
const escapeText = (text: string, table: boolean) => text.replace(table ? /[\\`*_[\]<>|]/g : /[\\`*_[\]<>]/g, '\\$&');

/** The common typing path works on strings rather than per-character objects:
 * a long paragraph still needs only a bounded diff and its changed slices. */
function textEdits(old: PMNode, next: PMNode, md: Md, source: string, table: boolean): Patch[] | null {
  const a = nodes(old), b = nodes(next), leaves: Md[] = [];
  const visit = (n: Md) => { if (n.children) n.children.forEach(visit); else leaves.push(n); }; md.children?.forEach(visit);
  if (a.length !== b.length || a.length !== leaves.length || a.some((n, i) => !n.isText || !b[i]!.isText || !sameMarks(n.marks, b[i]!.marks) || leaves[i]!.type !== 'text' || n.text !== leaves[i]!.value)) return null;
  const edits: Patch[] = [];
  for (let i = 0; i < a.length; i++) {
    const before = a[i]!.text!, after = b[i]!.text!; if (before === after) continue;
    const leaf = leaves[i]!, raw = source.slice(leaf.position!.start.offset, leaf.position!.end.offset);
    const pieces = raw === before ? null : rawUnits(raw, before), offsets = [0];
    if (pieces) for (const piece of pieces) offsets.push(offsets.at(-1)! + piece.length);
    const parts = diffChars(before, after, { timeout: 80 }); if (!parts) return null;
    let offset = 0;
    for (let p = 0; p < parts.length;) {
      const part = parts[p]!; if (!part.added && !part.removed) { offset += part.value.length; p++; continue; }
      const start = offset; let inserted = '';
      while (p < parts.length && (parts[p]!.added || parts[p]!.removed)) { const chunk = parts[p++]!; if (chunk.removed) offset += chunk.value.length; if (chunk.added) inserted += chunk.value; }
      edits.push({ start: leaf.position!.start.offset + (pieces ? offsets[start]! : start), end: leaf.position!.start.offset + (pieces ? offsets[offset]! : offset), text: escapeText(inserted, table) });
    }
  }
  return edits;
}

function inlineSource(old: PMNode, next: PMNode, syntax: Md, source: string, table: boolean): { start: number; end: number; text: string } {
  const before = flatten(old), after = flatten(next), styles: Style[] = [], reusable: Reuse[] = [];
  let at = 0;
  const visit = (md: Md, inherited: readonly Mark[] = []) => {
    const start = at, raw = source.slice(md.position!.start.offset, md.position!.end.offset);
    const own = ({ strong: 'bold', emphasis: 'italic', delete: 'strike', inlineCode: 'code', link: 'link', linkReference: 'link' } as Record<string, string>)[md.type];
    const ownMark = own && before[at]?.marks.find(m => m.type.name === own);
    const all = ownMark ? [...inherited, ownMark] : inherited;
    if (md.children) md.children.forEach(c => visit(c, all));
    else if (md.type === 'image' || md.type === 'imageReference' || md.type === 'break') { if (before[at]) before[at++]!.raw = raw; }
    else {
      const value = md.type === 'text' || md.type === 'inlineCode' ? md.value ?? '' : raw;
      let body = raw;
      if (md.type === 'inlineCode') { const fence = /^`+/.exec(raw)?.[0] ?? '`'; body = raw.slice(fence.length, -fence.length); if (/^ .+ $/s.test(body) && /[^ ]/.test(body)) body = body.slice(1, -1); }
      const pieces = rawUnits(body, value, md.type === 'inlineCode');
      for (const piece of pieces) if (before[at]) before[at++]!.raw = piece;
    }
    const end = at;
    if (ownMark && end > start) {
      let open: string, close: string;
      if (md.type === 'inlineCode') { const fence = /^`+/.exec(raw)?.[0] ?? '`'; const body = raw.slice(fence.length, -fence.length); const padded = /^ .+ $/s.test(body) && /[^ ]/.test(body); open = fence + (padded ? ' ' : ''); close = (padded ? ' ' : '') + fence; }
      else { open = source.slice(md.position!.start.offset, md.children?.[0]?.position?.start.offset ?? md.position!.end.offset); close = source.slice(md.children?.at(-1)?.position?.end.offset ?? md.position!.start.offset, md.position!.end.offset); }
      styles.push({ mark: signature(ownMark), start, end, open, close });
    }
    if (end > start) reusable.push({ start, end, raw, inherited });
  };
  (syntax.children ?? []).forEach(n => visit(n));
  let oi = 0, ni = 0;
  for (const part of diffArrays(before.map(u => u.value), after.map(u => u.value), { timeout: 80 }) ?? []) {
    if (part.added) ni += part.value.length;
    else if (part.removed) oi += part.value.length;
    else for (let k = 0; k < part.value.length; k++) after[ni++]!.old = oi++;
  }
  const oldToNew = new Map<number, number>(); after.forEach((u, i) => { if (u.old !== undefined) oldToNew.set(u.old, i); });
  const reuse = new Map<number, Reuse>();
  for (const r of reusable.sort((a, b) => b.end - b.start - (a.end - a.start))) {
    const start = oldToNew.get(r.start) ?? -1, length = r.end - r.start;
    if (start < 0 || reuse.has(start)) continue;
    if (after.slice(start, start + length).length === length && after.slice(start, start + length).every((u, i) => u.old === r.start + i && sameMarks(u.marks, before[r.start + i]!.marks))) reuse.set(start, r);
  }
  let output = '', stack: { mark: Mark; close: string }[] = [];
  const setMarks = (marks: readonly Mark[], index: number) => {
    let shared = 0; while (shared < stack.length && shared < marks.length && stack[shared]!.mark.eq(marks[shared]!)) shared++;
    for (let i = stack.length - 1; i >= shared; i--) output += stack[i]!.close;
    stack = stack.slice(0, shared);
    for (const m of marks.slice(shared)) {
      const previous = after[index]?.old, style = styles.find(s => s.mark === signature(m) && previous !== undefined && previous >= s.start && previous < s.end) ?? styles.find(s => s.mark === signature(m));
      let open = style?.open, close = style?.close;
      if (!style) {
        if (m.type.name === 'link') { open = '['; close = `](${String(m.attrs.href ?? '').replace(/[\\()]/g, '\\$&')}${m.attrs.title ? ' "' + String(m.attrs.title).replace(/[\\"]/g, '\\$&') + '"' : ''})`; }
        else { open = close = ({ bold: '**', italic: '_', strike: '~~', code: '`' } as Record<string, string>)[m.type.name] ?? ''; }
      }
      if (m.type.name === 'code') { let end = index; while (end < after.length && after[end]!.marks.some(mark => mark.eq(m))) end++; const text = after.slice(index, end).map(u => u.value).join(''); const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length)); if (longest >= (open!.match(/^`+/)?.[0].length ?? 1)) { const fence = '`'.repeat(longest + 1), pad = /^[` ]|[` ]$/.test(text) && /[^ ]/.test(text) ? ' ' : ''; open = fence + pad; close = pad + fence; } }
      output += open; stack.push({ mark: m, close: close! });
    }
  };
  for (let i = 0; i < after.length;) {
    const u = after[i]!, r = reuse.get(i);
    if (r) { setMarks(r.inherited, i); output += r.raw; i += r.end - r.start; continue; }
    setMarks(u.marks, i);
    const previous = u.old === undefined ? undefined : before[u.old], code = u.marks.some(m => m.type.name === 'code');
    if (previous?.raw !== undefined && previous.marks.some(m => m.type.name === 'code') === code) output += previous.raw;
    else if (u.node?.type.name === 'hardBreak') output += '  \n';
    else if (u.node?.type.name === 'image') output += `![${escapeText(u.node.attrs.alt ?? '', table)}](${u.node.attrs.src ?? ''})`;
    else output += code ? u.value : escapeText(u.value, table);
    i++;
  }
  setMarks([], after.length);
  const first = syntax.children?.[0], last = syntax.children?.at(-1);
  const emptyAt = syntax.type === 'tableCell' ? syntax.position!.start.offset + (source.slice(syntax.position!.start.offset, syntax.position!.end.offset).match(/^\|?[ \t]*/)?.[0].length ?? 0) : syntax.position!.end.offset;
  return { start: first?.position?.start.offset ?? emptyAt, end: last?.position?.end.offset ?? emptyAt, text: output };
}

export function serializeSource(doc: PMNode, original: MarkdownDocument): string {
  if (doc.eq(original.doc)) return original.source;
  const source = original.source, newline = source.includes('\r\n') ? '\r\n' : '\n';
  const range = (m: Md) => ({ start: m.position!.start.offset, end: m.position!.end.offset });
  const inlinePool: { node: PMNode; syntax: Md; table: boolean }[] = [];
  const collect = (node: PMNode, md: Md, table = false) => {
    if (node.inlineContent && !['rawMarkdown', 'codeBlock'].includes(node.type.name)) { inlinePool.push({ node, syntax: md, table }); return; }
    if (['tableCell', 'tableHeader'].includes(node.type.name)) { collect(node.child(0), md, true); return; }
    node.forEach((child, _, i) => { if (md.children?.[i]) collect(child, md.children[i]!, table || node.type.name === 'table'); });
  };
  original.doc.forEach((n, _, i) => { const md = original.blocks[i]?.syntax; if (md) collect(n, md); });
  const emptySyntax: Md = { type: 'paragraph', children: [], position: { start: { offset: 0 }, end: { offset: 0 } } };
  const renderInline = (n: PMNode, table = false) => {
    const prior = inlinePool.find(p => p.node.content.eq(n.content));
    if (prior) { const text = inlineSource(prior.node, n, prior.syntax, source, table).text; const end = prior.syntax.children?.at(-1)?.position?.end.offset ?? prior.syntax.position!.end.offset; const suffix = source.slice(end, prior.syntax.position!.end.offset); return text + (/^[ \t]*$/.test(suffix) ? suffix : ''); }
    return inlineSource(n.type.create(), n, emptySyntax, '', table).text;
  };
  // Generate only new structural syntax. Existing inline descendants still
  // reuse their exact source, including references, entities and trailing space.
  const literal = (n: PMNode): string => {
    const type = n.type.name;
    if (type === 'rawMarkdown') return n.textContent;
    if (type === 'paragraph') return renderInline(n);
    if (type === 'heading') return '#'.repeat(n.attrs.level) + ' ' + renderInline(n);
    if (type === 'horizontalRule') return source.match(/^(?:[ \t]*)(?:\* *\* *\*[ *]*|- *- *-[ -]*|_ *_ *_[ _]*)$/m)?.[0] ?? '---';
    if (type === 'codeBlock') { const preferred = source.match(/^(?:[ \t]*)(`{3,}|~{3,})/m)?.[1] ?? '```'; const char = preferred[0]!, longest = Math.max(0, ...(n.textContent.match(new RegExp(char + '+', 'g')) ?? []).map(s => s.length)); const fence = char.repeat(Math.max(preferred.length, longest + 1)); return fence + (n.attrs.language ?? '') + newline + n.textContent.replace(/\n/g, newline) + newline + fence; }
    if (type === 'blockquote') return nodes(n).map(literal).join(newline + newline).split(newline).map(line => '> ' + line).join(newline);
    if (['bulletList', 'orderedList', 'taskList'].includes(type)) { const bullet = source.match(/^[ \t]*([-+*])[ \t]+/m)?.[1] ?? '-'; const suffix = source.match(/^[ \t]*\d+([.)])[ \t]+/m)?.[1] ?? '.'; return nodes(n).map((item, i) => { const prefix = type === 'orderedList' ? String((n.attrs.start ?? 1) + i) + suffix + ' ' : bullet + ' '; const check = type === 'taskList' ? (item.attrs.checked ? '[x] ' : '[ ] ') : ''; const lines = nodes(item).map(literal).join(newline + newline).split(newline); return prefix + check + lines[0] + lines.slice(1).map(line => newline + ' '.repeat(prefix.length + check.length) + line).join(''); }).join(newline); }
    if (type === 'table') { const rows = nodes(n).map(row => '| ' + nodes(row).map(cell => renderInline(cell.child(0), true)).join(' | ') + ' |'); const separator = '| ' + nodes(n.child(0)).map(cell => cell.attrs.markdownAlign === 'left' ? ':---' : cell.attrs.markdownAlign === 'right' ? '---:' : cell.attrs.markdownAlign === 'center' ? ':---:' : '---').join(' | ') + ' |'; return [rows[0], separator, ...rows.slice(1)].join(newline); }
    return nodes(n).map(literal).join(newline + newline);
  };
  const patch = (old: PMNode, next: PMNode, md: Md, table = false): Patch[] => {
    if (old.eq(next)) return [];
    const r = range(md), raw = source.slice(r.start, r.end), a = nodes(old), b = nodes(next);
    if (old.isTextblock && next.isTextblock && !['rawMarkdown', 'codeBlock'].includes(old.type.name) && !['rawMarkdown', 'codeBlock'].includes(next.type.name)) {
      if (old.type.name === next.type.name && JSON.stringify(old.attrs) === JSON.stringify(next.attrs)) { const edits = textEdits(old, next, md, source, table); if (edits) return edits; }
      const edit = inlineSource(old, next, md, source, table), result: Patch[] = [{ ...edit, text: edit.text.replace(/\r?\n/g, newline) }];
      if (old.type.name !== next.type.name || old.attrs.level !== next.attrs.level) {
        const inlineStart = md.children?.[0]?.position?.start.offset ?? r.start;
        const prefix = next.type.name === 'heading' ? '#'.repeat(next.attrs.level) + ' ' : '';
        result.push({ start: r.start, end: inlineStart, text: prefix });
        // Setext headings have their underline after the inline content.
        if (old.type.name === 'heading' && !/^#{1,6}\s/.test(raw)) result.push({ start: edit.end, end: r.end, text: '' });
      }
      return result;
    }
    if (old.type.name === 'rawMarkdown' && next.type.name === 'rawMarkdown') return [{ ...r, text: next.textContent }];
    if (old.type.name === 'codeBlock' && next.type.name === 'codeBlock' && old.attrs.language === next.attrs.language) {
      const start = raw.indexOf('\n') + 1, fence = /^(\s*)(`{3,}|~{3,})/.exec(raw);
      if (fence && start) { const close = raw.lastIndexOf(newline + fence[1] + fence[2]); if (close >= 0 && !next.textContent.split('\n').some(line => new RegExp('^\\s*' + (fence[2]![0] === '`' ? '`' : '~') + '{' + fence[2]!.length + ',}\\s*$').test(line))) return [{ start: r.start + start, end: r.start + Math.max(start, close), text: next.textContent.replace(/\n/g, newline) + (close < start && next.textContent ? newline : '') }]; }
    }
    if (['tableCell', 'tableHeader'].includes(old.type.name) && ['tableCell', 'tableHeader'].includes(next.type.name)) return patch(a[0]!, b[0]!, md, true);
    if (old.type.name === 'table' && next.type.name === 'table' && (a.length !== b.length || a.some((row, i) => row.childCount !== b[i]?.childCount))) return tableRows(old, next, md);
    if (old.type.name === next.type.name && a.length === b.length && md.children?.length === a.length && !(old.type.name === 'tableRow' && md.children.some((cell, i) => cell.position!.start.offset === cell.position!.end.offset && !a[i]!.eq(b[i]!)))) {
      const edits = a.flatMap((n, i) => patch(n, b[i]!, md.children![i]!, table || old.type.name === 'table' || old.type.name === 'tableRow'));
      if (JSON.stringify(old.attrs) === JSON.stringify(next.attrs)) return edits;
      // Task checkboxes are attributes, not text leaves.
      if (old.type.name === 'taskItem' && old.attrs.checked !== next.attrs.checked) { const check = /\[[ xX]\]/.exec(raw); if (check) return [...edits, { start: r.start + check.index + 1, end: r.start + check.index + 2, text: next.attrs.checked ? 'x' : ' ' }]; }
    }
    if (old.type.name === next.type.name && ['bulletList', 'orderedList', 'taskList', 'blockquote', 'listItem', 'taskItem'].includes(old.type.name) && md.children?.length === a.length) {
      const list = ['bulletList', 'orderedList', 'taskList'].includes(old.type.name);
      return sequence(a, b, md.children, (node, index) => {
        if (!list) return literal(node);
        const sample = source.slice(md.children![Math.min(index, md.children!.length - 1)]!.position!.start.offset), prefix = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?/.exec(sample)?.[1] ?? '- ';
        const marker = old.type.name === 'orderedList' ? prefix.replace(/\d+/, String((next.attrs.start ?? 1) + index)) : prefix;
        const check = old.type.name === 'taskList' ? node.attrs.checked ? '[x] ' : '[ ] ' : '';
        return marker + check + nodes(node).map(literal).join(newline + newline).split(newline).map((line, i) => i ? ' '.repeat(marker.length + check.length) + line : line).join(newline);
      }, list, list ? newline : newline + newline);
    }
    if (old.type.name === 'table' && next.type.name === 'table') return tableRows(old, next, md);
    if (old.type.name === 'tableRow' && next.type.name === 'tableRow') {
      // Structural column changes: reuse matched cell spellings, keep compact
      // separators instead of padding every cell to a new column width.
      const contents = b.map((cell, i) => {
        const match = a.findIndex(c => c.eq(cell)); const previous = match >= 0 ? md.children?.[match] : md.children?.[i];
        const oldCell = match >= 0 ? a[match] : a[i];
        if (previous && oldCell) {
          const p = oldCell.child(0), q = cell.child(0), text = inlineSource(p, q, previous, source, true).text;
          const first = previous.children?.[0]?.position?.start.offset ?? previous.position!.end.offset, last = previous.children?.at(-1)?.position?.end.offset ?? first;
          const prefix = source.slice(previous.position!.start.offset, first).replace(/^[ \t]*\|/, ''), suffix = source.slice(last, previous.position!.end.offset).replace(/\|[ \t]*$/, '');
          return prefix + text + suffix;
        }
        const space = /\| /.test(raw), text = renderInline(cell.child(0), true); return space ? ` ${text} ` : text;
      });
      return [{ ...r, text: (raw.match(/^[ \t]*\|/)?.[0] ?? '') + contents.join('|') + (raw.match(/\|[ \t]*$/)?.[0] ?? '') }];
    }
    return [{ ...r, text: literal(next) }];
  };
  function tableRows(old: PMNode, next: PMNode, md: Md): Patch[] {
    const a = nodes(old), b = nodes(next), rows = md.children ?? [];
    const matching = new Map<number, number>(), used = new Set<number>();
    for (let i = 0; i < b.length; i++) { const found = a.findIndex((n, j) => !used.has(j) && n.eq(b[i]!)); if (found >= 0) { matching.set(i, found); used.add(found); } }
    const rowText = b.map((node, i) => {
      let index = matching.get(i);
      if (index === undefined) { index = a.findIndex((_, j) => !used.has(j)); if (index >= 0) used.add(index); }
      if (index !== undefined && index >= 0) {
        const oldRow = rows[index]!, r = range(oldRow), raw = source.slice(r.start, r.end);
        return apply(raw, patch(a[index]!, node, oldRow, true).map(p => ({ ...p, start: p.start - r.start, end: p.end - r.start })));
      }
      const sample = rows[Math.min(1, rows.length - 1)]!, raw = source.slice(sample.position!.start.offset, sample.position!.end.offset), space = /\| /.test(raw);
      return (/^\s*\|/.test(raw) ? '|' : '') + nodes(node).map(cell => {
        const p = cell.child(0), empty = p.type.create(), syntax: Md = { type: 'tableCell', children: [], position: { start: { offset: 0 }, end: { offset: 0 } } };
        const text = inlineSource(empty, p, syntax, '', true).text; return space ? ` ${text} ` : text;
      }).join('|') + (/\|\s*$/.test(raw) ? '|' : '');
    });
    const delimiterStart = source.indexOf('\n', rows[0]!.position!.end.offset) + 1, nextLine = source.indexOf('\n', delimiterStart), delimiterEnd = nextLine < 0 ? md.position!.end.offset : nextLine - (source[nextLine - 1] === '\r' ? 1 : 0);
    let delimiter = source.slice(delimiterStart, delimiterEnd);
    if (a[0]?.childCount !== b[0]?.childCount) {
      const segments = delimiter.split('|').filter(c => c.trim());
      delimiter = (delimiter.trimStart().startsWith('|') ? '|' : '') + nodes(b[0]!).map((cell, i) => {
        const found = nodes(a[0]!).findIndex(c => c.eq(cell));
        return segments[found >= 0 ? found : i] ?? segments.at(-1) ?? ' --- ';
      }).join('|') + (delimiter.trimEnd().endsWith('|') ? '|' : '');
    }
    return [{ ...range(md), text: rowText.length ? rowText[0] + newline + delimiter + (rowText.length > 1 ? newline + rowText.slice(1).join(newline) : '') : '' }];
  }
  /** Align unchanged siblings first; pair changed nodes locally, preserving all
   * original gaps. Insertions and removals own only their own separator. */
  function sequence(a: PMNode[], b: PMNode[], syntax: Md[], create: (node: PMNode, index: number) => string, row = false, gap?: string): Patch[] {
    const edits: Patch[] = []; let oi = 0, ni = 0, removed = 0, added = 0;
    const flush = () => {
      const count = Math.min(removed, added);
      for (let i = 0; i < count; i++) edits.push(...patch(a[oi + i]!, b[ni + i]!, syntax[oi + i]!, row));
      if (removed > count) {
        const first = oi + count, last = oi + removed - 1, r = { start: syntax[first]!.position!.start.offset, end: syntax[last]!.position!.end.offset };
        if (row) { if (source.slice(r.end, r.end + newline.length) === newline) r.end += newline.length; }
        else if (last + 1 < syntax.length) r.end = syntax[last + 1]!.position!.start.offset;
        else if (first > 0) r.start = syntax[first - 1]!.position!.end.offset;
        edits.push({ ...r, text: '' });
      }
      if (added > count) {
        const index = oi + removed, at = syntax[index]?.position?.start.offset ?? syntax.at(-1)?.position?.end.offset ?? 0;
        const separator = gap ?? (row ? newline : newline + newline);
        const text = b.slice(ni + count, ni + added).map((node, i) => create(node, index + i)).join(separator);
        edits.push({ start: at, end: at, text: (index === syntax.length && syntax.length ? separator : '') + text + (index < syntax.length ? separator : '') });
      }
      oi += removed; ni += added; removed = added = 0;
    };
    for (const part of diffArrays(a.map(n => JSON.stringify(n.toJSON())), b.map(n => JSON.stringify(n.toJSON())), { timeout: 100 }) ?? [{ removed: true, value: a }, { added: true, value: b }]) {
      if (part.removed) removed += part.value.length;
      else if (part.added) added += part.value.length;
      else { flush(); oi += part.value.length; ni += part.value.length; }
    }
    flush(); return edits;
  }
  return apply(source, sequence(nodes(original.doc), nodes(doc), original.blocks.map(b => b.syntax), n => literal(n)));
}
