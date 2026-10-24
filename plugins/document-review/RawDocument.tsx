import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { makeAnchor } from './model';
import { CommentMenu, type CommentTarget } from './CommentMenu';
import type { RichDocumentHandle } from './RichDocument';

/** Source editing deliberately bypasses the rich parser: every byte stays editable. */
export const RawDocument = forwardRef<RichDocumentHandle, { content: string; editable?: boolean; onChange: (value: string) => void; onComment: (range: { start: number; end: number }) => void; onDeselect: () => void }>(function RawDocument(props, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<CommentTarget | null>(null);
  const history = useRef({ past: [] as string[], future: [] as string[], current: props.content, at: 0 });
  // Remote proposals/decisions must never be undone by the local typing history.
  if (history.current.current !== props.content) history.current = { past: [], future: [], current: props.content, at: 0 };
  function change(value: string) {
    const h = history.current, now = Date.now();
    if (now - h.at > 500 || !h.past.length) h.past.push(h.current);
    while (h.past.length > 1 && (h.past.length > 100 || h.past.reduce((bytes, text) => bytes + text.length * 2, 0) > 2_000_000)) h.past.shift();
    h.future = []; h.at = now; h.current = value; props.onChange(value);
  }
  function undo(redo = false) {
    const h = history.current, from = redo ? h.future : h.past, to = redo ? h.past : h.future, value = from.pop();
    if (value === undefined) return;
    to.push(h.current); h.current = value; h.at = 0; props.onChange(value); input.current?.focus();
  }
  function selection() { const el = input.current; return el && el.selectionEnd > el.selectionStart ? { start: el.selectionStart, end: el.selectionEnd } : null; }
  function target() {
    const el = input.current, selected = selection();
    if (selected) return selected;
    const at = el?.selectionStart ?? 0, start = (at === 0 ? 0 : props.content.lastIndexOf('\n', at - 1) + 1), next = props.content.indexOf('\n', at);
    return { start, end: next < 0 ? props.content.length : next };
  }
  useImperativeHandle(ref, () => ({ selection, undo: () => undo(), redo: () => undo(true), scrollTo(start, end = start) {
    const el = input.current; if (!el) return;
    el.focus(); el.setSelectionRange(start, end);
    const line = props.content.slice(0, start).split('\n').length - 1;
    el.scrollTop = Math.max(0, line * (parseFloat(getComputedStyle(el).lineHeight) || 24) - el.clientHeight / 3);
  } }));
  return <div className="dr-raw-editor"><p className="dr-tiny">Raw Markdown · edits use the same tracking setting. Suggestions and comments remain in the review sidebar.</p><textarea ref={input} aria-label="Raw Markdown" spellCheck={false} readOnly={props.editable === false} value={props.content} onChange={e => change(e.target.value)} onPointerDown={e => { if (e.button === 0) { props.onDeselect(); setMenu(null); } }} onContextMenu={e => {
    if (e.shiftKey) return;
    const range = target(); if (range.end <= range.start) return;
    e.preventDefault(); setMenu({ anchor: makeAnchor(props.content, range.start, range.end), x: e.clientX, y: e.clientY });
  }} onKeyDown={e => {
    if (e.key === 'Escape') { setMenu(null); props.onDeselect(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) { e.preventDefault(); const range = target(); if (range.end > range.start) props.onComment(range); }
  }} />{menu && <CommentMenu target={menu} close={() => setMenu(null)} choose={anchor => setMenu({ ...menu, anchor })} comment={anchor => props.onComment({ start: anchor.start, end: anchor.end })} />}</div>;
});
