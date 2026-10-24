import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { targetLabel } from './comment-target';
import type { Anchor } from './model';
export type CommentTarget = { anchor: Anchor; x: number; y: number; choices?: Anchor[] };
export function CommentMenu({ target, comment, choose, close }: { target: CommentTarget; comment: (anchor: Anchor, choices?: Anchor[]) => void; choose?: (anchor: Anchor) => void; close: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', key);
    const el = menu.current;
    if (el) { const r = el.getBoundingClientRect(); if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`; }
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', key); };
  }, [close]);
  return createPortal(<div ref={menu} className="dr-context-menu" role="menu" aria-label="Document actions" style={{ top: Math.max(8, Math.min(target.y, window.innerHeight - 110)), left: Math.max(8, Math.min(target.x, window.innerWidth - 230)) }}><div className="dr-tiny">{targetLabel(target.anchor)}</div><button type="button" role="menuitem" onClick={() => { comment(target.anchor, target.choices); close(); }}>Comment here</button>{target.choices && target.choices.length > 1 && <div className="dr-scope-options" aria-label="Comment scope">{target.choices.map(a => <button type="button" key={`${a.element?.tag}:${a.element?.selector}:${a.start}:${a.end}`} aria-pressed={a.start === target.anchor.start && a.end === target.anchor.end} onClick={() => choose?.(a)}>{targetLabel(a, false)}</button>)}</div>}</div>, document.body);
}
