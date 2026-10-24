import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { htmlPreview, findHtmlTarget, makeHtmlAnchor, visualHtmlChanges, type HtmlTarget } from './html-document';
import { htmlBridgeScript } from './html-bridge';
import { pointerArea } from './html-interaction';
import { mapOffset } from './review-state';
import type { Anchor } from './model';
import type { RichDocumentHandle } from './RichDocument';
import type { HtmlDocumentProps } from './HtmlDocument';
import { CommentMenu, type CommentTarget } from './CommentMenu';

const number = z.number().finite().min(-10_000_000).max(10_000_000);
const rect = z.object({ left: number, top: number, width: number.nonnegative(), height: number.nonnegative() });
const gestureSchema = z.object({ key: z.string().max(120), box: rect, selectedText: z.string().max(2000).optional(), textRange: z.object({ start: z.number().int().nonnegative().max(500_000), end: z.number().int().nonnegative().max(500_000) }).optional(), pointer: z.object({ x: number, y: number, capturedAt: z.string().max(80), hitKey: z.string().max(120), hitBox: rect, scrollX: number, scrollY: number, width: number.nonnegative(), height: number.nonnegative() }).optional() });
type Gesture = z.infer<typeof gestureSchema>;
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const boxSchema = rect.extend({ kind: z.enum(['comment', 'passive', 'draft', 'change']), point: point.optional(), pinOnly: z.boolean().optional() });
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }), z.object({ type: z.literal('clear') }), z.object({ type: z.literal('picking') }), z.object({ type: z.literal('checkpoint') }),
  z.object({ type: z.literal('picked'), id: z.string().max(120) }),
  z.object({ type: z.literal('geometry'), boxes: z.array(boxSchema).max(800), scrollY: number, scrollX: number }),
  z.object({ type: z.literal('hover'), anchor: gestureSchema }),
  z.object({ type: z.literal('context'), anchor: gestureSchema, choices: z.array(gestureSchema).max(5), x: number, y: number }),
  z.object({ type: z.literal('comment'), anchor: gestureSchema, choices: z.array(gestureSchema).max(5) }),
]);

/** All source identity is reconstructed in BB; the sandbox supplies only gesture geometry. */
export function anchorFromGesture(content: string, targets: HtmlTarget[], g: Gesture): Anchor | null {
  const target = targets.find(t => t.key === g.key); if (!target) return null;
  const x = g.pointer ? (g.pointer.x - g.box.left) / Math.max(1, g.box.width) : undefined;
  const y = g.pointer ? (g.pointer.y - g.box.top) / Math.max(1, g.box.height) : undefined;
  const hit = g.pointer && targets.find(t => t.key === g.pointer!.hitKey);
  if (g.pointer && !hit) return null;
  const p = g.pointer, pointer = p && hit ? { capturedAt: p.capturedAt, client: { x: p.x, y: p.y }, document: { x: p.x + p.scrollX, y: p.y + p.scrollY }, viewport: { width: p.width, height: p.height }, targetBox: g.box, area: pointerArea(x!, y!), insideTarget: x! >= 0 && x! <= 1 && y! >= 0 && y! <= 1, hit: { tag: hit.element.tag, selector: hit.element.selector, sourceStart: hit.start, sourceEnd: hit.end, text: hit.element.text, html: hit.element.html, attributes: hit.element.attributes, box: p.hitBox } } : undefined;
  return makeHtmlAnchor(content, target.key, x === undefined ? undefined : { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y!)) }, g.selectedText, pointer, g.textRange, targets);
}

type Entry = { key: string; kind: 'comment' | 'passive' | 'draft' | 'change'; id?: string; size?: number; point?: { x: number; y: number }; selectedText?: string; textRange?: { start: number; end: number } };
export const InteractiveHtmlDocument = forwardRef<RichDocumentHandle, HtmlDocumentProps>(function InteractiveHtmlDocument(props, ref) {
  const frame = useRef<HTMLIFrameElement>(null), latest = useRef(props); latest.current = props;
  const channel = useMemo(() => crypto.randomUUID(), [props.id, props.content]);
  const preview = useMemo(() => htmlPreview(props.content, props.id, { interactive: true, bridge: htmlBridgeScript(channel), assetOrigin: window.location.origin }), [props.content, props.id, channel]);
  const [ready, setReady] = useState(false), [menu, setMenu] = useState<CommentTarget | null>(null), [hover, setHover] = useState<Anchor | null>(null), [picking, setPicking] = useState(false), [boxes, setBoxes] = useState<z.infer<typeof boxSchema>[]>([]);
  const position = useRef(0), restored = useRef(''), pendingScroll = useRef<string | null>(null);
  const send = useCallback((type: string, data: Record<string, unknown> = {}) => frame.current?.contentWindow?.postMessage({ channel, type, ...data }, '*'), [channel]);
  const close = useCallback(() => setMenu(null), []);
  useEffect(() => {
    setReady(false); setMenu(null); setHover(null); setPicking(false); setBoxes([]);
    const receive = (event: MessageEvent) => {
      // Opaque documents have origin "null". A matching WindowProxy and channel
      // are required; messages can never invoke file or plugin mutations.
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || event.data?.channel !== channel) return;
      const result = messageSchema.safeParse(event.data); if (!result.success) return; const m = result.data;
      if (m.type === 'ready') { setReady(true); clearInterval(retry); if (restored.current !== channel) { restored.current = channel; send('restore', { top: position.current }); if (pendingScroll.current) { send('scroll', { key: pendingScroll.current }); pendingScroll.current = null; } } }
      else if (m.type === 'geometry') { position.current = m.scrollY; setBoxes(old => JSON.stringify(old) === JSON.stringify(m.boxes) ? old : m.boxes); }
      else if (m.type === 'clear') { latest.current.onDeselect(); setMenu(null); setPicking(false); setHover(null); }
      else if (m.type === 'picked') { if (latest.current.comments.some(c => c.id === m.id && c.status !== 'resolved')) latest.current.onPick?.(m.id); }
      else if (m.type === 'picking') { setPicking(true); setHover(null); }
      else if (m.type === 'context' || m.type === 'comment' || m.type === 'hover') {
        const anchor = anchorFromGesture(latest.current.content, preview.targets, m.anchor); if (!anchor) return;
        if (m.type === 'hover') { setHover(anchor); return; }
        const choices = m.choices.map(g => anchorFromGesture(latest.current.content, preview.targets, g)).filter((a): a is Anchor => !!a);
        latest.current.onDeselect(); setPicking(false); setHover(null);
        if (m.type === 'comment') { setMenu(null); latest.current.onComment(anchor, choices); }
        else { const r = frame.current!.getBoundingClientRect(); setMenu({ anchor, choices, x: r.left + m.x, y: r.top + m.y }); }
      }
    };
    window.addEventListener('message', receive); send('hello');
    let tries = 0; const retry = setInterval(() => { if (++tries >= 40) clearInterval(retry); send('hello'); }, 250);
    return () => { clearInterval(retry); window.removeEventListener('message', receive); };
  }, [channel, preview, send]);
  const entries = useMemo(() => {
    const entries: Entry[] = [];
    const add = (anchor: Anchor, kind: Entry['kind'], id?: string) => {
      if (anchor.orphaned) return;
      const t = findHtmlTarget(anchor, preview.targets, anchor.start); if (t) entries.push({ key: t.key, kind, ...(id ? { id } : {}), size: anchor.element?.selectedText?.length ?? anchor.end - anchor.start, ...(anchor.element?.point ? { point: anchor.element.point } : {}), ...(anchor.element?.selectedText ? { selectedText: anchor.element.selectedText, textRange: anchor.element.textRange } : {}) });
    };
    for (const change of props.changes) {
      const edits = visualHtmlChanges(change), keys = new Set<string>();
      for (const e of edits.slice(0, 100)) {
        const start = change.start + mapOffset(e.start, edits, -1), end = change.start + mapOffset(e.end, edits, 1);
        const t = preview.targets.filter(t => t.start <= start && t.end >= end).sort((a, b) => a.end - a.start - (b.end - b.start))[0]; if (t) keys.add(t.key);
      }
      for (const key of keys) entries.push({ key, kind: 'change' });
    }
    for (const c of props.comments) if (c.status !== 'resolved' && c.anchor) add(c.anchor, c.id === props.active ? 'comment' : 'passive', c.id);
    const draft = menu?.anchor ?? props.draft ?? (picking ? hover : null); if (draft) add(draft, 'draft');
    return entries;
  }, [preview, props.comments, props.changes, props.active, props.draft, menu, picking, hover]);
  useEffect(() => { if (ready) send('state', { entries }); }, [ready, entries, send]);
  useImperativeHandle(ref, () => ({
    selection: () => null, undo: () => {}, redo: () => {}, startComment: () => send('pick'),
    scrollTo(start, end, id) {
      const c = latest.current.comments.find(c => c.id === id);
      const t = c?.anchor && !c.anchor.orphaned ? findHtmlTarget(c.anchor, preview.targets, c.anchor.start) : !c ? preview.targets.filter(t => t.start <= start && t.end >= (end ?? start)).sort((a, b) => a.end - a.start - (b.end - b.start))[0] : undefined;
      if (t) { if (ready) send('scroll', { key: t.key }); else pendingScroll.current = t.key; }
    },
  }), [preview, ready, send]);
  return <div className="dr-html-document">{picking && <div className="dr-html-hint" role="status">Click what you want to discuss. Escape cancels.</div>}<div className="dr-html-frame"><iframe ref={frame} title="HTML document preview" sandbox="allow-scripts allow-modals" allow="" referrerPolicy="no-referrer" srcDoc={preview.html} onLoad={() => send('hello')} /><div className="dr-html-overlay" aria-hidden="true">{boxes.map((b, i) => <div key={i} className={`dr-html-target dr-html-target-${b.kind}${b.pinOnly ? ' dr-html-target-pin-only' : ''}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>{b.point && b.kind !== 'change' && <span className="dr-html-pin" style={{ left: `${b.point.x * 100}%`, top: `${b.point.y * 100}%` }}>●</span>}</div>)}</div></div>{menu && <CommentMenu target={menu} close={close} choose={anchor => setMenu({ ...menu, anchor })} comment={props.onComment} />}</div>;
});
