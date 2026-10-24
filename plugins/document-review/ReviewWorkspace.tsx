import { useEffect, useRef, useState, type ReactNode } from 'react';
const preferenceKey = 'document-review.sidebar-size';
function storedSize() {
  try { const value = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}'); return { width: Number.isFinite(value.width) ? Math.max(240, Math.min(900, value.width)) : 310, height: Number.isFinite(value.height) ? Math.max(140, Math.min(900, value.height)) : 280 }; }
  catch { return { width: 310, height: 280 }; }
}
export function ReviewWorkspace({ hidden, document, sidebar }: { hidden: boolean; document: ReactNode; sidebar: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), drag = useRef(false);
  const [size, setSize] = useState(storedSize), [bounds, setBounds] = useState({ width: 1000, height: 600 });
  const stacked = bounds.width <= 780;
  const max = Math.max(stacked ? 140 : 240, (stacked ? bounds.height - 126 : bounds.width - 266));
  const current = Math.min(max, stacked ? size.height : size.width), min = stacked ? 140 : 240;
  useEffect(() => {
    const el = root.current; if (!el) return;
    const update = () => { const r = el.getBoundingClientRect(); if (r.width && r.height) setBounds({ width: r.width, height: r.height }); };
    update(); const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null; observer?.observe(el);
    window.addEventListener('resize', update); return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(size)); } catch { /* Local preferences may be unavailable. */ } }, [size]);
  function resize(value: number) { const next = Math.max(min, Math.min(max, value)); setSize(s => ({ ...s, [stacked ? 'height' : 'width']: next })); }
  return <div ref={root} className={`dr-workspace ${hidden ? 'dr-sidebar-hidden' : ''} ${stacked ? 'dr-stacked' : ''}`} style={hidden ? undefined : stacked ? { gridTemplateColumns: 'minmax(0,1fr)', gridTemplateRows: `minmax(0,1fr) 6px ${current}px` } : { gridTemplateColumns: `minmax(0,1fr) 6px ${current}px`, gridTemplateRows: 'minmax(0,1fr)' }}>
    {document}
    {!hidden && <div className="dr-review-divider" role="separator" aria-label="Resize review sidebar" aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(current)} tabIndex={0} title={stacked ? 'Drag up or down to resize comments' : 'Drag left or right to resize comments'}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (!drag.current || !root.current) return; const r = root.current.getBoundingClientRect(); resize(stacked ? r.bottom - e.clientY : r.right - e.clientX); }}
      onPointerUp={e => { drag.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = false; }} onLostPointerCapture={() => { drag.current = false; }}
      onKeyDown={e => { const grow = stacked ? 'ArrowUp' : 'ArrowLeft', shrink = stacked ? 'ArrowDown' : 'ArrowRight'; if ([grow, shrink, 'Home', 'End'].includes(e.key)) { e.preventDefault(); resize(e.key === 'Home' ? min : e.key === 'End' ? max : current + (e.key === grow ? 1 : -1) * (e.shiftKey ? 60 : 20)); } }} />}
    {sidebar}
  </div>;
}
