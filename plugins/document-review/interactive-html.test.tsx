// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { htmlPreview } from './html-document';
import { htmlBridgeScript } from './html-bridge';
import { InteractiveHtmlDocument, anchorFromGesture } from './InteractiveHtmlDocument';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const source = '<main><button id="tank" onclick="this.textContent=\'Selected\'">Tank</button><p id="text">Choose your class.</p><script>window.pageRan=true;</script></main>';
describe('isolated interactive HTML', () => {
  it('preserves page scripts and handlers, retains CSP restrictions, and can still produce a static preview', () => {
    const view = htmlPreview(source, 'review', { interactive: true, bridge: htmlBridgeScript('test-channel'), assetOrigin: 'http://localhost:38886' });
    expect(view.html).toContain('window.pageRan=true'); expect(view.html).toContain('onclick='); expect(view.html).toContain("connect-src 'none'"); expect(view.html).toContain("frame-src 'none'"); expect(view.html).toContain("form-action 'none'"); expect(view.scriptsDisabled).toBe(false);
    expect(view.html.indexOf('const channel=')).toBeLessThan(view.html.indexOf('window.pageRan=true'));
    expect(() => new Function(htmlBridgeScript('test-channel'))).not.toThrow();
    const staticView = htmlPreview(source, 'review'); expect(staticView.html).not.toContain('<script'); expect(staticView.html).not.toContain('onclick='); expect(staticView.scriptsDisabled).toBe(true);
  });
  it('rejects other windows, stale channels, invalid references, and oversized geometry; reconstructs valid comment anchors', async () => {
    const onComment = vi.fn(), onPick = vi.fn();
    const view = render(<InteractiveHtmlDocument id="review" content={source} comments={[]} changes={[]} active="" draft={null} onComment={onComment} onDeselect={() => {}} onPick={onPick} />);
    const frame = view.getByTitle('HTML document preview') as HTMLIFrameElement;
    expect(frame.sandbox?.toString?.() ?? frame.getAttribute('sandbox')).not.toContain('allow-same-origin'); expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    const channel = JSON.parse(frame.srcdoc.match(/const channel=("[^"]+");/)![1]!);
    const targets = htmlPreview(source, 'review').targets, target = targets.find(t => t.element.attributes.id === 'tank')!;
    const gesture = { key: target.key, box: { left: 10, top: 20, width: 100, height: 40 } };
    const post = (data: unknown, origin = 'null', sender: MessageEventSource | null = frame.contentWindow) => fireEvent(window, new MessageEvent('message', { source: sender, origin, data }));
    const message = { channel, type: 'comment', anchor: gesture, choices: [gesture] };
    post(message, 'null', window); post({ ...message, channel: 'old-source' }); post(message, 'https://unrelated.example'); post({ ...message, anchor: { ...gesture, key: 'not-in-source' } });
    expect(onComment).not.toHaveBeenCalled();
    post({ channel, type: 'geometry', scrollX: 0, scrollY: 0, boxes: Array.from({ length: 801 }, () => ({ ...gesture.box, kind: 'comment' })) }); expect(view.container.querySelector('.dr-html-target')).toBeNull();
    post(message); expect(onComment).toHaveBeenCalledOnce(); expect(onComment.mock.calls[0]![0]).toMatchObject({ quote: 'Tank', element: { attributes: { id: 'tank' } } });
    post({ channel, type: 'context', anchor: gesture, choices: [gesture], x: 30, y: 40 }); const menu = await within(document.body).findByRole('menu', { name: 'Document actions' }); expect(menu.textContent).toContain('Tank');
    post({ channel, type: 'picked', id: 'unrelated-comment' }); expect(onPick).not.toHaveBeenCalled();
    const remove = vi.spyOn(window, 'removeEventListener'); view.unmount(); expect(remove.mock.calls.some(c => c[0] === 'message')).toBe(true);
  });
  it('keeps pointer hit context when widening scope without trusting element names from the page', () => {
    const targets = htmlPreview(source, 'review').targets, section = targets.find(t => t.element.tag === 'main')!, button = targets.find(t => t.element.attributes.id === 'tank')!;
    const gesture = { key: section.key, box: { left: 0, top: 0, width: 500, height: 400 }, pointer: { x: 495, y: 4, capturedAt: '2026-10-18', hitKey: button.key, hitBox: { left: 450, top: 0, width: 50, height: 30 }, scrollX: 0, scrollY: 100, width: 1000, height: 800 } };
    const anchor = anchorFromGesture(source, targets, gesture)!; expect(anchor.element?.tag).toBe('main'); expect(anchor.element?.pointer).toMatchObject({ area: 'top-right corner', hit: { tag: 'button', attributes: { id: 'tank' } }, document: { x: 495, y: 104 } });
    expect(anchorFromGesture(source, targets, { ...gesture, pointer: { ...gesture.pointer, hitKey: 'fake' } })).toBeNull();
  });
});
