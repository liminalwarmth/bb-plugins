import { isHtml, parseHtml, reanchorHtml } from './html-document';
import { computeChanges, reanchor, type Anchor, type Change, type HistoryEntry, type Session } from './model';

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
export function mapOffset(offset: number, edits: Change[], bias: -1 | 1 = 1): number {
  let delta = 0;
  for (const e of edits) {
    if (offset < e.start) break;
    if (offset > e.end) { delta += e.after.length - (e.end - e.start); continue; }
    if (e.start === e.end) return e.start + delta + (bias > 0 ? e.after.length : 0);
    if (offset === e.start) return e.start + delta;
    if (offset === e.end) return e.start + delta + e.after.length;
    return e.start + delta + (bias > 0 ? e.after.length : 0);
  }
  return offset + delta;
}
export function touches(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}
export function event(kind: HistoryEntry['kind'], summary: string, changes?: Change[]): HistoryEntry {
  return { id: uid('event'), kind, summary, createdAt: new Date().toISOString(), ...(changes ? { changes } : {}) };
}
export function applyEdits(content: string, edits: Pick<Change, 'start' | 'end' | 'after'>[]): string {
  let text = content;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, e.start) + e.after + text.slice(e.end);
  return text;
}
/** The file contains only committed wording; pending suggestions live in BB. */
export function committedContent(s: Pick<Session, 'content' | 'changes'>): string {
  const changes = [...s.changes].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    if (c.start < 0 || c.end < c.start || c.end > s.content.length || s.content.slice(c.start, c.end) !== c.after || (i > 0 && changes[i - 1]!.end > c.start)) {
      throw new Error('A pending suggestion no longer matches the review text. The source file was not changed.');
    }
  }
  return applyEdits(s.content, changes.map(c => ({ start: c.start, end: c.end, after: c.before })));
}
export function mergeConcurrent(base: string, current: string, edited: string): string {
  if (current === base) return edited;
  if (current === edited) return current;
  const remote = computeChanges(base, current), local = computeChanges(base, edited);
  if (local.some(e => remote.some(r => (touches(e, r) || (e.start === r.start && e.end === r.end)) && e.after !== r.after))) throw new Error('Your typing overlaps a new agent or external edit. Your local draft is still in the editor; download a copy before using the latest document.');
  const patches = local.filter(e => !remote.some(r => e.start === r.start && e.end === r.end && e.after === r.after)).map(e => ({ ...e, start: mapOffset(e.start, remote, 1), end: mapOffset(e.end, remote, -1) }));
  return applyEdits(current, patches);
}
export function shiftAnchor(a: Anchor | null, content: string, edits: Change[]): Anchor | null {
  if (!a) return null;
  if (a.element?.format === 'html') return reanchorHtml(a, content, undefined, edits.some(e => e.start <= a.start && e.end > a.start) ? undefined : mapOffset(a.start, edits, -1));
  if (a.orphaned) return reanchor(a, content);
  let start = mapOffset(a.start, edits, a.start === a.end ? -1 : 1);
  let end = mapOffset(a.end, edits, a.start === a.end ? 1 : -1);
  // A replacement that covers an anchor boundary owns the successor passage.
  // A complete deletion keeps a point marker instead of dropping the thread.
  for (const e of edits) if (touches(a, e) || (a.removed && a.start === a.end && e.start <= a.start && e.end >= a.end)) {
    start = Math.min(start, mapOffset(e.start, edits, -1));
    end = Math.max(end, mapOffset(e.end, edits, 1));
  }
  start = Math.max(0, Math.min(start, content.length));
  end = Math.max(start, Math.min(end, content.length));
  const removed = start === end || (!!a.quote.trim() && !content.slice(start, end).trim());
  if (removed) end = start;
  return { ...a, start, end, prefix: content.slice(Math.max(0, start - 80), start), suffix: content.slice(end, end + 80), orphaned: false, removed };
}
function shiftComments(s: Session, next: string, edits: Change[]) {
  const targets = s.comments.some(c => c.anchor?.element?.format === 'html') ? parseHtml(next).targets : undefined;
  s.comments = s.comments.map(c => ({ ...c, anchor: c.anchor?.element?.format === 'html' ? reanchorHtml(c.anchor, next, targets, edits.some(e => e.start <= c.anchor!.start && e.end > c.anchor!.start) ? undefined : mapOffset(c.anchor.start, edits, -1)) : shiftAnchor(c.anchor, next, edits) }));
}
/** Repair old orphan anchors using a known saved snapshot, never a guessed offset. */
export function repairCommentAnchors(s: Session): boolean {
  let changed = false;
  for (const c of s.comments) {
    if (!c.anchor?.orphaned) continue;
    const a = c.anchor;
    if (a.element?.format === 'html') { const recovered = reanchorHtml(a, s.content); if (!recovered.orphaned) { c.anchor = recovered; changed = true; } continue; }
    const recovered = s.diskContent.slice(a.start, a.end) === a.quote
      ? shiftAnchor({ ...a, orphaned: false }, s.content, computeChanges(s.diskContent, s.content))
      : reanchor(a, s.content);
    if (recovered && !recovered.orphaned) { c.anchor = recovered; changed = true; }
  }
  return changed;
}
function threadEvent(c: Session['comments'][number], kind: NonNullable<Session['comments'][number]['replies'][number]['kind']>, body: string, changeId?: string) {
  if (kind === 'revision' && c.replies.some(r => r.kind === kind && r.changeId === changeId)) return;
  c.replies.push({ body, kind, author: { kind: 'system', name: 'Document Review' }, createdAt: new Date().toISOString(), ...(changeId ? { changeId } : {}) });
}

/** Conservative normalization for an ambiguous patch set. Accepted wording is
 * always the base, so even a fallback cannot leak pending edits to the file. */
export function rebuildPending(s: Session, base: string, content: string, source: 'user' | 'agent' = 'user') {
  const first = s.changes[0];
  s.content = content;
  s.changes = base === content ? [] : [{ id: first?.id ?? uid('change'), start: 0, end: content.length, before: base, after: content, decision: 'pending', source }];
}
function preserveBaseline(s: Session, base: string, source: 'user' | 'agent') {
  try { if (committedContent(s) === base) return; } catch { /* Normalize invalid ranges too. */ }
  rebuildPending(s, base, s.content, source);
  s.notice = 'Some adjacent suggestions were combined to preserve their original text. Your file was not changed.';
}

/** Human edits become part of the document. Only suggestions they actually
 * replace are retired; everything else keeps its ID and relative position. */
export function editDocument(s: Session, content: string): HistoryEntry[] {
  const edits = computeChanges(s.content, content);
  if (!edits.length) return [];
  const retired = s.changes.filter(c => edits.some(e => touches(c, e)));
  s.changes = s.changes.filter(c => !retired.includes(c)).map(c => ({ ...c, start: mapOffset(c.start, edits, 1), end: mapOffset(c.end, edits, c.start === c.end ? 1 : -1) }));
  shiftComments(s, content, edits); s.content = content;
  return [...retired.map(c => event('edited', 'You edited this suggestion directly', [c])), event('manual-edit', 'Document edited', edits)];
}

/** Tracking off means direct author decisions, including mixed selections.
 * Retire suggestions actually edited into History; untouched suggestions keep
 * their IDs and stay excluded from committed content. Toggling the mode alone
 * never changes pending work. */
export function editUntrackedDocument(s: Session, content: string): HistoryEntry[] {
  return editDocument(s, content);
}

/** New agent text is diffed against the CURRENT document, not the first
 * snapshot. Overlapping pending suggestions are updated/merged while keeping
 * their original rejection text. Prior decisions live independently in history. */
function proposeHtml(s: Session, content: string, source: 'agent' | 'user'): HistoryEntry[] {
  const actual = computeChanges(s.content, content); if (!actual.length) return [];
  const base = applyEdits(s.content, s.changes.map(c => ({ ...c, after: c.before })));
  const edits = computeChanges(base, content), previous = s.changes;
  let pending: Change[] = [];
  if (edits.length) {
    const first = edits[0]!, last = edits.at(-1)!, start = mapOffset(first.start, edits, -1), end = mapOffset(last.end, edits, 1);
    pending = [{ id: previous[0]?.id ?? uid('change'), start, end, before: base.slice(first.start, last.end), after: content.slice(start, end), decision: 'pending', source }];
    for (const note of s.comments) if (note.anchor && actual.some(e => touches(note.anchor!, e))) threadEvent(note, 'revision', 'Agent proposed an HTML update for this passage.', pending[0]!.id);
  }
  shiftComments(s, content, actual); s.content = content; s.changes = pending;
  return [...(previous.length && !pending.length ? [event('superseded', 'HTML proposal withdrawn', previous)] : []), event('agent-update', 'HTML document update (reviewed together to keep markup intact)', actual)];
}

export function proposeDocument(s: Session, content: string, source: 'agent' | 'user' = 'agent'): HistoryEntry[] {
  if (isHtml(s.path)) return proposeHtml(s, content, source);
  const committed = committedContent(s);
  const edits = computeChanges(s.content, content);
  if (!edits.length) return [];
  const oldContent = s.content, previous = s.changes;
  const groups = edits.map(e => ({ start: e.start, end: e.end, edits: [e], previous: [] as Change[] }));
  // Word diff can anchor URL punctuation (such as a dot) to sentence
  // punctuation. Keep the entire link wrapper in one reversible decision.
  for (let i = 0; i < groups.length - 1; i++) {
    const first = groups[i]!, open = first.edits[0]!;
    const removing = !!open.before;
    if ((open.before || open.after) !== '[') continue;
    const next = groups[i + 1]!.edits[0]!;
    if (!(removing ? next.before : next.after).startsWith('](')) continue;
    for (let j = i + 1; j < groups.length; j++) {
      const part = groups[j]!;
      if (oldContent.slice(first.end, part.start).includes('\n') || part.edits.some(e => removing ? !!e.after : !!e.before)) break;
      if (part.edits.some(e => (removing ? e.before : e.after).includes(')'))) {
        const rest = groups.splice(i + 1, j - i); first.end = rest.at(-1)!.end; first.edits.push(...rest.flatMap(g => g.edits)); break;
      }
    }
  }
  // Paired Markdown delimiters are one formatting decision, including when
  // there is no pre-existing suggestion between them.
  const delimiter = (e: Change) => /^(?:[*_~`]+|\[|\]\([^\n]*\))$/.test(e.before || e.after) && (!e.before || !e.after);
  for (let i = 0; i < groups.length - 1; i++) {
    const left = groups[i]!, right = groups[i + 1]!;
    if (left.edits.every(delimiter) && right.edits.every(delimiter) && !oldContent.slice(left.end, right.start).includes('\n')) {
      left.end = right.end; left.edits.push(...right.edits); groups.splice(i + 1, 1); i--;
    }
  }
  // Join connected edits through any old suggestion that spans both.
  for (const old of previous) {
    const hits = groups.filter(g => touches(g, old) || (g.start === g.end && g.start === old.start && old.start === old.end) || (source === 'user' && (g.start === old.end || g.end === old.start)));
    if (!hits.length) continue;
    const first = hits[0]!; first.previous.push(old); first.start = Math.min(first.start, old.start); first.end = Math.max(first.end, old.end);
    for (const other of hits.slice(1)) {
      first.start = Math.min(first.start, other.start); first.end = Math.max(first.end, other.end);
      first.edits.push(...other.edits); first.previous.push(...other.previous); groups.splice(groups.indexOf(other), 1);
    }
  }
  const affected = new Set(groups.flatMap(g => g.previous));
  const pending = previous.filter(c => !affected.has(c)).map(c => ({ ...c, start: mapOffset(c.start, edits, 1), end: mapOffset(c.end, edits, -1) }));
  const history: HistoryEntry[] = [];
  for (const g of groups) {
    const oldSuggestions = [...new Set(g.previous)].sort((a, b) => a.start - b.start);
    const before = applyEdits(oldContent.slice(g.start, g.end), oldSuggestions.map(c => ({ start: c.start - g.start, end: c.end - g.start, after: c.before })));
    const after = applyEdits(oldContent.slice(g.start, g.end), g.edits.map(e => ({ start: e.start - g.start, end: e.end - g.start, after: e.after })));
    const start = mapOffset(g.start, edits, -1);
    if (before !== after) {
      const id = oldSuggestions[0]?.id ?? uid('change');
      pending.push({ id, start, end: start + after.length, before, after, decision: 'pending', source });
      for (const comment of s.comments) if (comment.anchor && !comment.anchor.orphaned && (touches(comment.anchor, g) || (comment.anchor.start === comment.anchor.end && comment.anchor.start >= g.start && comment.anchor.start <= g.end))) {
        threadEvent(comment, 'revision', source === 'user' ? 'You proposed an edit to this passage.' : 'Agent proposed an edit to this passage.', id);
      }
    }
    if (oldSuggestions.length > 1 || before === after) history.push(event('superseded', 'Updated or combined earlier suggestions', before === after ? oldSuggestions : oldSuggestions.slice(1)));
  }
  shiftComments(s, content, edits); s.content = content;
  s.changes = pending.sort((a, b) => a.start - b.start || a.end - b.end);
  preserveBaseline(s, committed, source);
  return [...history, event(source === 'user' ? 'manual-edit' : 'agent-update', source === 'user' ? 'Your tracked edits' : 'Agent revised the current document', edits)];
}

/** Accept the complete pending set without repeatedly rebuilding the source. */
export function acceptAllChanges(s: Session): HistoryEntry | null {
  committedContent(s); // Validate the entire patch set before changing anything.
  if (!s.changes.length) return null;
  const accepted = s.changes.map(c => ({ ...c, decision: 'accepted' as const }));
  const ids = new Set(accepted.map(c => c.id));
  for (const comment of s.comments) if (comment.replies.some(r => r.changeId && ids.has(r.changeId)) || (comment.anchor && !comment.anchor.orphaned && accepted.some(c => touches(comment.anchor!, c) || (comment.anchor!.start === c.start && comment.anchor!.end === c.end)))) {
    threadEvent(comment, 'accepted', 'All pending edits accepted.');
  }
  s.changes = [];
  return event('accepted', `Accepted all ${accepted.length} changes`, accepted);
}

export function decideChange(s: Session, id: string, decision: 'accepted' | 'rejected'): HistoryEntry {
  const committed = committedContent(s);
  const c = s.changes.find(c => c.id === id);
  if (!c) throw new Error('This suggestion has already been handled.');
  for (const comment of s.comments) if (comment.replies.some(r => r.changeId === id) || (comment.anchor && !comment.anchor.orphaned && (touches(comment.anchor, c) || (comment.anchor.start === c.start && comment.anchor.end === c.end)))) {
    threadEvent(comment, decision, decision === 'accepted' ? 'Edit accepted.' : 'Edit rejected; previous wording restored.', id);
  }
  s.changes = s.changes.filter(x => x.id !== id);
  if (decision === 'rejected') {
    const edit: Change = { ...c, before: c.after, after: c.before };
    const content = applyEdits(s.content, [edit]);
    s.changes = s.changes.map(other => ({ ...other, start: mapOffset(other.start, [edit], 1), end: mapOffset(other.end, [edit], -1) }));
    shiftComments(s, content, [edit]); s.content = content;
  }
  if (decision === 'rejected') preserveBaseline(s, committed, c.source ?? 'agent');
  return event(decision, decision === 'accepted' ? 'Suggestion accepted' : 'Suggestion rejected', [{ ...c, decision }]);
}

/** External edits are applied over the last saved file. Unrelated local edits
 * survive. A recovery snapshot retains conflicting local text for 14 days. */
export function reconcileDisk(s: Session, diskContent: string, diskSha: string): { history: HistoryEntry[]; stale: string[] } {
  if (diskSha === s.diskSha) return { history: [], stale: [] };
  const oldContent = s.content, oldChanges = structuredClone(s.changes), external = computeChanges(s.diskContent, diskContent);
  const snapshot = structuredClone(s); let delta = 0;
  const survivors: Change[] = [], stale: string[] = [];
  for (const c of [...oldChanges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = c.start + delta, end = start + c.before.length;
    delta += c.before.length - (c.end - c.start);
    const overlaps = external.some(e => touches({ start, end }, e) ||
      (start === end && e.start <= start && e.end >= end) ||
      (e.start === e.end && e.start >= start && e.start <= end));
    const mapped = mapOffset(start, external, 1);
    if (overlaps || diskContent.slice(mapped, mapped + c.before.length) !== c.before) stale.push(c.id);
    else survivors.push({ ...c, start: mapped, end: mapped + c.before.length });
  }
  let next = applyEdits(diskContent, survivors.map(c => ({ ...c, after: c.after })));
  const currentChanges = survivors.map(c => { const start = mapOffset(c.start, survivors, -1); return { ...c, start, end: start + c.after.length }; });
  shiftComments(s, next, computeChanges(oldContent, next)); s.content = next; s.changes = currentChanges;
  s.diskContent = diskContent; s.diskSha = diskSha;
  let fallback = false;
  try { fallback = committedContent(s) !== diskContent; } catch { fallback = true; }
  if (fallback) {
    next = diskContent; Object.assign(s, { ...snapshot, diskContent, diskSha });
    shiftComments(s, next, computeChanges(oldContent, next)); s.content = next; s.changes = [];
    for (const c of oldChanges) if (!stale.includes(c.id)) stale.push(c.id);
  }
  s.notice = stale.length ? 'The file changed outside Document Review. Overlapping suggestions were retired; your previous review is in History for 14 days.' : 'The file changed outside Document Review. Unaffected review work was kept.';
  const history: HistoryEntry[] = stale.length ? [{ ...event('external-rebase', 'Review before overlapping outside edits', oldChanges.filter(c => stale.includes(c.id))), snapshot: oldContent }] : [];
  return { history, stale };
}

export function migrateLegacy(raw: Record<string, any>): { session: Session; history: HistoryEntry[] } {
  const base = String(raw.base ?? ''), oldChanges = (raw.changes ?? []) as Change[];
  const edits = oldChanges.map(c => ({ ...c, after: c.decision === 'rejected' ? c.before : c.after }));
  const content = applyEdits(base, edits);
  const pending = oldChanges.filter(c => c.decision === 'pending').map(c => {
    const start = mapOffset(c.start, edits, -1); return { ...c, start, end: start + c.after.length };
  });
  const completed = pending.length === 0 && content === (raw.savedContent ?? base) && (raw.comments ?? []).every((c: any) => c.status === 'resolved');
  const session: Session = { formatVersion: 2, id: raw.id, path: raw.path, hostId: raw.hostId, rootPath: raw.rootPath, threadId: raw.threadId ?? null, title: raw.title, trackChanges: true, content, diskContent: raw.savedContent ?? base, diskSha: raw.savedSha ?? raw.baseSha, changes: pending, comments: (raw.comments ?? []).map((c: any) => ({ ...c, anchor: shiftAnchor(c.anchor ? { ...c.anchor, orphaned: false } : null, content, edits) })), revision: raw.revision + 1, dirty: true, completedAt: completed ? raw.updatedAt : null, notice: null, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
  return { session, history: oldChanges.filter(c => c.decision !== 'pending').map(c => ({ ...event(c.decision as 'accepted' | 'rejected', 'Decision from the previous review version', [c]), createdAt: raw.updatedAt })) };
}
