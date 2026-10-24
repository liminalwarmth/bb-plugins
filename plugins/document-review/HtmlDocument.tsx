import { InteractiveHtmlDocument } from './InteractiveHtmlDocument';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { htmlPreview, findHtmlTarget, visualHtmlChanges } from './html-document';
import { type Anchor, type Change, type Comment } from './model';
import { mapOffset } from './review-state';
import { anchorForHtmlNode, selectedHtmlNode, textRangeForAnchor, type PointerGesture } from './html-interaction';
import { CommentMenu, type CommentTarget } from './CommentMenu';
import type { RichDocumentHandle } from './RichDocument';

export type HtmlDocumentProps = { interactive?: boolean; id: string; content: string; comments: Comment[]; changes: Change[]; active: string; draft: Anchor | null; onComment: (anchor: Anchor, choices?: Anchor[]) => void; onDeselect: () => void; onPick?: (id: string) => void };
type Box = { left: number; top: number; width: number; height: number; kind: 'comment' | 'passive' | 'draft' | 'change'; point?: { x: number; y: number }; pinOnly?: boolean };
export const StaticHtmlDocument = forwardRef<RichDocumentHandle, HtmlDocumentProps>(function StaticHtmlDocument(props, ref) {
  const iframe = useRef<HTMLIFrameElement>(null), latest = useRef(props); latest.current = props;
  const [loaded, setLoaded] = useState(0), [menu, setMenu] = useState<CommentTarget | null>(null), [picking, setPicking] = useState(false), [hover, setHover] = useState<Anchor | null>(null), [boxes, setBoxes] = useState<Box[]>([]);
  const pickingRef = useRef(picking); pickingRef.current = picking;
  const preview = useMemo(() => htmlPreview(props.content, props.id), [props.content, props.id]);
  const previewRef = useRef(preview); previewRef.current = preview;
  const scrollPosition = useRef(0), pointer = useRef<PointerGesture | undefined>(undefined), selected = useRef<{ range: Range; source: string } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  useEffect(() => { pointer.current = undefined; selected.current = null; setMenu(null); setHover(null); return () => { pointer.current = undefined; selected.current = null; }; }, [props.content]);
  // All DOM/range references belong to this iframe load and are discarded with it.
  const elements = useMemo(() => {
    const result = new Map<string, Element>();
    if (loaded) for (const el of Array.from(iframe.current?.contentDocument?.querySelectorAll('[data-dr-node]') ?? [])) result.set(el.getAttribute('data-dr-node')!, el);
    return result;
  }, [loaded, preview]);
  const bindings = useMemo(() => props.comments.filter(c => c.status !== 'resolved' && c.anchor && !c.anchor.orphaned).flatMap(comment => {
    const target = findHtmlTarget(comment.anchor!, preview.targets, comment.anchor!.start), node = target && elements.get(target.key);
    return node ? [{ comment, node, range: textRangeForAnchor(node, comment.anchor!) }] : [];
  }), [props.comments, preview, elements]);
  const bindingsRef = useRef(bindings); bindingsRef.current = bindings;
  const changedElements = useMemo(() => {
    const nodes = new Set<Element>();
    for (const change of props.changes) {
      const edits = visualHtmlChanges(change);
      for (const e of edits.slice(0, 100)) {
        const start = change.start + mapOffset(e.start, edits, -1), end = change.start + mapOffset(e.end, edits, 1);
        const target = preview.targets.filter(t => t.start <= start && t.end >= end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        const node = target && elements.get(target.key); if (node) nodes.add(node);
      }
    }
    return [...nodes];
  }, [props.changes, preview, elements]);
  function meaningful(el: Element): Element {
    const interactive = el.closest('button,a,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],img,svg,video,canvas,picture,figure');
    if (interactive) return interactive;
    if (!['SPAN', 'STRONG', 'EM', 'I', 'B', 'SMALL'].includes(el.tagName) && el.hasAttribute('data-dr-node')) return el;
    return el.closest('h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,label,section,article,header,footer,nav,aside,main,form,[id],[role],[aria-label]') ?? el.closest('[data-dr-node]') ?? iframe.current!.contentDocument!.body;
  }
  function rememberPointer(el: Element, x: number, y: number) {
    pointer.current = { element: el, x, y, capturedAt: new Date().toISOString() };
  }
  function anchorFor(node: Element, range?: Range): Anchor | null {
    return anchorForHtmlNode(latest.current.content, node, previewRef.current.targets, pointer.current, range);
  }
  function captureSelection(): Range | null {
    const doc = iframe.current?.contentDocument, sel = doc?.getSelection();
    if (doc && sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim() && doc.body.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0).cloneRange(); selected.current = { range, source: latest.current.content }; return range;
    }
    return selected.current?.source === latest.current.content ? selected.current.range : null;
  }
  function targetFor(el: Element, x?: number, y?: number, useSelection = true) {
    if (x !== undefined && y !== undefined) rememberPointer(el, x, y);
    const range = useSelection ? captureSelection() : null, selectionNode = range ? selectedHtmlNode(el.ownerDocument, range) : null;
    let node: Element | null = selectionNode?.contains(el) ? selectionNode : meaningful(el);
    const anchor = anchorFor(node, selectionNode === node ? range ?? undefined : undefined), choices: Anchor[] = [];
    while (node && choices.length < 5) {
      if (node.hasAttribute('data-dr-node') && !['html', 'span', 'strong', 'em', 'i'].includes(node.tagName.toLowerCase())) { const a = anchorFor(node); if (a) choices.push(a); }
      node = node.parentElement;
    }
    return { anchor, choices };
  }
  function beginFromSelection(): boolean {
    const doc = iframe.current?.contentDocument, range = captureSelection(); if (!doc || !range) return false;
    const node = selectedHtmlNode(doc, range); if (!node) return false;
    const anchor = anchorFor(node, range); if (!anchor) return false;
    const t = targetFor(node, undefined, undefined, false);
    setPicking(false); setHover(null); setMenu(null); latest.current.onComment(anchor, t.choices); return true;
  }
  useEffect(() => {
    const doc = iframe.current?.contentDocument; if (!doc || !loaded) return;
    const click = (e: MouseEvent) => {
      latest.current.onDeselect(); close(); const el = e.target as Element;
      if (el?.closest?.('a,button,input,form')) e.preventDefault();
      if (!pickingRef.current && el?.nodeType === 1) {
        const matches = bindingsRef.current.filter(b => {
          if (!b.node.contains(el)) return false;
          const rects = b.range ? Array.from(b.range.getClientRects()) : [];
          return rects.length ? rects.some(r => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) : true;
        }).map(b => b.comment).sort((a, b) => (a.anchor!.element?.selectedText?.length ?? a.anchor!.end - a.anchor!.start) - (b.anchor!.element?.selectedText?.length ?? b.anchor!.end - b.anchor!.start));
        if (doc.getSelection()?.isCollapsed && matches[0]) latest.current.onPick?.(matches[0].id);
      }
      if (pickingRef.current && el?.nodeType === 1) { e.preventDefault(); const t = targetFor(el, e.clientX, e.clientY); setPicking(false); setHover(null); if (t.anchor) latest.current.onComment(t.anchor, t.choices); }
    };
    let hoverFrame = 0;
    const move = (e: MouseEvent) => {
      const el = e.target as Element; if (el?.nodeType !== 1) return;
      rememberPointer(el, e.clientX, e.clientY);
      if (pickingRef.current && !hoverFrame) hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; const hit = pointer.current?.element; if (pickingRef.current && hit?.isConnected) setHover(anchorFor(meaningful(hit))); });
    };
    const selectionChanged = () => { const sel = doc.getSelection(); if (sel?.isCollapsed && doc.hasFocus()) selected.current = null; else captureSelection(); };
    const down = (e: PointerEvent) => { if (e.button === 0) selected.current = null; if ((e.target as Element)?.nodeType === 1) rememberPointer(e.target as Element, e.clientX, e.clientY); };
    const context = (e: MouseEvent) => {
      if (e.shiftKey) { close(); return; }
      const el = e.target as Element; if (!el?.closest) return;
      const t = targetFor(el, e.clientX, e.clientY); if (!t.anchor) return;
      e.preventDefault(); latest.current.onDeselect(); setPicking(false); setHover(null);
      const frame = iframe.current!.getBoundingClientRect(); setMenu({ anchor: t.anchor, choices: t.choices, x: frame.left + e.clientX, y: frame.top + e.clientY });
    };
    const submit = (e: Event) => e.preventDefault();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { latest.current.onDeselect(); close(); setPicking(false); setHover(null); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); iframe.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); }
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) { e.preventDefault(); if (!beginFromSelection()) { setPicking(true); setHover(null); } }
    };
    const scrolled = () => { scrollPosition.current = doc.scrollingElement?.scrollTop ?? 0; };
    doc.addEventListener('selectionchange', selectionChanged); doc.addEventListener('pointerdown', down);
    doc.addEventListener('scroll', scrolled, { passive: true }); doc.addEventListener('click', click, true); doc.addEventListener('mousemove', move); doc.addEventListener('contextmenu', context); doc.addEventListener('submit', submit, true); doc.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(hoverFrame); doc.removeEventListener('selectionchange', selectionChanged); doc.removeEventListener('pointerdown', down); doc.removeEventListener('scroll', scrolled); doc.removeEventListener('click', click, true); doc.removeEventListener('mousemove', move); doc.removeEventListener('contextmenu', context); doc.removeEventListener('submit', submit, true); doc.removeEventListener('keydown', key); };
  }, [loaded, preview.html, close]);
  useEffect(() => {
    const doc = iframe.current?.contentDocument, win = doc?.defaultView; if (!doc || !loaded || !win) return;
    const active = bindings.find(b => b.comment.id === props.active);
    const anchor = menu?.anchor ?? props.draft ?? (picking ? hover : null) ?? active?.comment.anchor;
    const target = anchor && !anchor.orphaned ? findHtmlTarget(anchor, preview.targets, anchor.start) : null;
    const focused = target ? elements.get(target.key) : null, focusRange = focused && anchor ? textRangeForAnchor(focused, anchor) : null;
    const update = () => {
      const next: Box[] = [], width = win.innerWidth, height = win.innerHeight;
      const add = (r: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, kind: Box['kind'], point?: Box['point'], pinOnly?: boolean) => {
        if (r.left + r.width < 0 || r.top + r.height < 0 || r.left > width || r.top > height) return;
        next.push({ left: r.left, top: r.top, width: r.width, height: r.height, kind, ...(point ? { point } : {}), ...(pinOnly ? { pinOnly } : {}) });
      };
      for (const node of changedElements) add(node.getBoundingClientRect(), 'change');
      for (const b of bindings) {
        if (b.comment.id === props.active) continue;
        const r = b.node.getBoundingClientRect();
        if (r.bottom < 0 || r.top > height || r.right < 0 || r.left > width) continue;
        const rects = b.range ? Array.from(b.range.getClientRects()) : [];
        if (rects.length) for (const r of rects) add(r, 'passive'); else add(r, 'passive', b.comment.anchor?.element?.point);
      }
      if (focused && anchor) {
        const kind = menu || props.draft || picking ? 'draft' : 'comment', rects = focusRange ? Array.from(focusRange.getClientRects()) : [];
        if (rects.length) {
          for (const r of rects) add(r, kind);
          if (anchor.element?.point) { const r = focused.getBoundingClientRect(), p = anchor.element.point; add({ left: r.left + p.x * r.width, top: r.top + p.y * r.height, width: 0, height: 0 }, kind, { x: 0, y: 0 }, true); }
        } else add(focused.getBoundingClientRect(), kind, anchor.element?.point);
      }
      setBoxes(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update(); let pending = 0, disposed = false;
    const schedule = () => { if (!pending && !disposed) pending = requestAnimationFrame(() => { pending = 0; if (!disposed) update(); }); };
    doc.addEventListener('scroll', schedule, { passive: true }); doc.addEventListener('load', schedule, true);
    win.addEventListener('resize', schedule); window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (doc.body) observer?.observe(doc.body);
    void doc.fonts?.ready.then(schedule);
    return () => { disposed = true; cancelAnimationFrame(pending); observer?.disconnect(); doc.removeEventListener('scroll', schedule); doc.removeEventListener('load', schedule, true); win.removeEventListener('resize', schedule); window.removeEventListener('resize', schedule); };
  }, [loaded, preview, elements, bindings, changedElements, props.active, props.draft, menu, picking, hover]);
  useEffect(() => { const doc = iframe.current?.contentDocument; if (doc) doc.documentElement.style.cursor = picking ? 'crosshair' : ''; }, [loaded, picking]);
  useImperativeHandle(ref, () => ({
    selection: () => null, undo: () => {}, redo: () => {}, startComment: () => { if (!beginFromSelection()) { setPicking(true); setMenu(null); } },
    commentAnchor: () => { const doc = iframe.current?.contentDocument; return doc ? targetFor(doc.getSelection()?.anchorNode?.parentElement ?? doc.body).anchor : null; },
    scrollTo(start, end, id) {
      const doc = iframe.current?.contentDocument; if (!doc) return;
      const note = latest.current.comments.find(c => c.id === id);
      const target = note?.anchor && !note.anchor.orphaned ? findHtmlTarget(note.anchor, previewRef.current.targets, note.anchor.start) : !note ? previewRef.current.targets.filter(t => t.start <= start && t.end >= (end ?? start)).sort((a, b) => a.end - a.start - (b.end - b.start))[0] : undefined;
      if (target) elements.get(target.key)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  }), [loaded, preview, elements]);
  return <div className="dr-html-document">{(picking || preview.scriptsDisabled) && <div className="dr-html-hint" role="status">{picking ? 'Click what you want to discuss. Escape cancels.' : 'Interactive scripts are off; some parts may look different from the live page.'}</div>}<div className="dr-html-frame"><iframe ref={iframe} title="HTML document preview" sandbox="allow-same-origin" allow="" referrerPolicy="no-referrer" srcDoc={preview.html} onLoad={() => { iframe.current?.contentWindow?.scrollTo({ top: scrollPosition.current, behavior: 'instant' }); setLoaded(n => n + 1); }} /><div className="dr-html-overlay" aria-hidden="true">{boxes.map((b, i) => <div key={i} className={`dr-html-target dr-html-target-${b.kind}${b.pinOnly ? ' dr-html-target-pin-only' : ''}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>{b.point && b.kind !== 'change' && <span className="dr-html-pin" style={{ left: `${b.point.x * 100}%`, top: `${b.point.y * 100}%` }}>●</span>}</div>)}</div></div>{menu && <CommentMenu target={menu} close={close} choose={anchor => setMenu({ ...menu, anchor })} comment={props.onComment} />}</div>;
});

export const HtmlDocument = forwardRef<RichDocumentHandle, HtmlDocumentProps>(function HtmlDocument(props, ref) { return props.interactive === false ? <StaticHtmlDocument {...props} ref={ref} /> : <InteractiveHtmlDocument {...props} ref={ref} />; });
