import { useEffect, useLayoutEffect, useRef, useState } from 'react';
/** Retain removed cards briefly so decisions fade/slide after they succeed. */
export function useDismissal<T extends { id: string; type: string; position: number }>(items: T[]) {
  const previous = useRef(items), timers = useRef(new Map<string, number>());
  const [leaving, setLeaving] = useState(new Map<string, T>());
  useLayoutEffect(() => {
    const current = new Set(items.map(i => i.id));
    const removed = previous.current.filter(i => i.type !== 'draft' && !current.has(i.id)); previous.current = items;
    setLeaving(old => {
      const next = new Map(old); let changed = false;
      for (const id of current) if (next.delete(id)) { window.clearTimeout(timers.current.get(id)); timers.current.delete(id); changed = true; }
      for (const item of removed) { next.set(item.id, item); changed = true; }
      return changed ? next : old;
    });
    for (const item of removed) {
      window.clearTimeout(timers.current.get(item.id));
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      timers.current.set(item.id, window.setTimeout(() => { timers.current.delete(item.id); setLeaving(old => { const next = new Map(old); next.delete(item.id); return next; }); }, reduced ? 0 : 220));
    }
  }, [items]);
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);
  const ids = new Set(items.map(i => i.id));
  return { items: [...items, ...[...leaving.values()].filter(i => !ids.has(i.id))].sort((a, b) => a.position - b.position || (a.type === 'draft' ? 1 : b.type === 'draft' ? -1 : a.id.localeCompare(b.id))), exiting: leaving };
}
