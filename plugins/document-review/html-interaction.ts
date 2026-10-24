import type { Anchor, PointerContext } from './model';
import { makeHtmlAnchor, type HtmlTarget } from './html-document';
export type PointerGesture = { element: Element; x: number; y: number; capturedAt: string };
const rect = (r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height });
export function pointerArea(x: number, y: number): string {
  if (x < 0 || x > 1 || y < 0 || y > 1) return 'outside selected target';
  const horizontal = x <= .2 ? 'left' : x >= .8 ? 'right' : '', vertical = y <= .2 ? 'top' : y >= .8 ? 'bottom' : '';
  return vertical && horizontal ? `${vertical}-${horizontal} corner` : vertical || horizontal ? `${vertical || horizontal} edge` : 'center';
}
export function anchorForHtmlNode(source: string, node: Element, targets: HtmlTarget[], gesture?: PointerGesture, selected?: Range): Anchor | null {
  const key = node.getAttribute('data-dr-node'); if (!key) return null;
  const box = node.getBoundingClientRect(), doc = node.ownerDocument, win = doc.defaultView;
  const x = gesture ? (gesture.x - box.left) / Math.max(box.width, 1) : undefined, y = gesture ? (gesture.y - box.top) / Math.max(box.height, 1) : undefined;
  const point = x !== undefined && y !== undefined ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : undefined;
  let pointer: PointerContext | undefined;
  if (gesture) {
    const hitNode = gesture.element.closest('[data-dr-node]'), hit = targets.find(t => t.key === hitNode?.getAttribute('data-dr-node'));
    if (hit && hitNode) pointer = { capturedAt: gesture.capturedAt, client: { x: gesture.x, y: gesture.y }, document: { x: gesture.x + (win?.scrollX ?? 0), y: gesture.y + (win?.scrollY ?? 0) }, viewport: { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 }, targetBox: rect(box), area: pointerArea(x!, y!), insideTarget: x! >= 0 && x! <= 1 && y! >= 0 && y! <= 1, hit: { tag: hit.element.tag, selector: hit.element.selector, sourceStart: hit.start, sourceEnd: hit.end, text: hit.element.text, html: hit.element.html, attributes: hit.element.attributes, box: rect(hitNode.getBoundingClientRect()) } };
  }
  let selectedText: string | undefined, textRange: { start: number; end: number } | undefined;
  if (selected && !selected.collapsed && node.contains(selected.startContainer) && node.contains(selected.endContainer)) {
    const prefix = doc.createRange(); prefix.selectNodeContents(node); prefix.setEnd(selected.startContainer, selected.startOffset);
    const start = prefix.toString().length;
    selectedText = selected.toString().slice(0, 2000); textRange = { start, end: start + selectedText.length };
  }
  return makeHtmlAnchor(source, key, point, selectedText, pointer, textRange, targets);
}
export function selectedHtmlNode(doc: Document, range: Range): Element | null {
  let node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
  while (node && !node.hasAttribute('data-dr-node')) node = node.parentElement;
  return node && doc.body.contains(node) ? node : null;
}
export function textRangeForAnchor(node: Element, anchor: Anchor): Range | null {
  const offsets = anchor.element?.textRange;
  if (!offsets || !anchor.element?.selectedText) return null;
  const doc = node.ownerDocument, walker = doc.createTreeWalker(node, 4), nodes: { node: Node; start: number; end: number }[] = [];
  let at = 0, n: Node | null; while ((n = walker.nextNode())) { const length = n.textContent?.length ?? 0; nodes.push({ node: n, start: at, end: at + length }); at += length; }
  const from = nodes.find(n => offsets.start >= n.start && offsets.start < n.end), to = nodes.find(n => offsets.end > n.start && offsets.end <= n.end);
  if (!from || !to) return null;
  const range = doc.createRange(); range.setStart(from.node, offsets.start - from.start); range.setEnd(to.node, offsets.end - to.start);
  if (range.toString() !== anchor.element.selectedText) return null;
  return range;
}
export function textRects(node: Element, anchor: Anchor): DOMRect[] {
  const range = textRangeForAnchor(node, anchor);
  return range ? Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0) : [];
}
