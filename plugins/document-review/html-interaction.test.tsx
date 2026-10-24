// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { anchorForHtmlNode, pointerArea } from './html-interaction';
import { makeHtmlAnchor, htmlPreview } from './html-document';
import * as model from './model';
import * as htmlDocument from './html-document';
import { StaticHtmlDocument as HtmlDocument } from './HtmlDocument';
import type { RichDocumentHandle } from './RichDocument';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const source = '<main id="page"><section id="pricing"><p>Choose <strong>your plan</strong> today.</p><button id="go"><span>Start now</span></button></section></main>';
const rectangle = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
describe('HTML gesture references', () => {
  it('retains the actual pointer hit and corner when the comment scope is widened', () => {
    const preview = htmlPreview(source, 'test'), root = document.createElement('div'); root.innerHTML = preview.html;
    const scope = root.querySelector('section')!, hit = root.querySelector('span')!;
    scope.getBoundingClientRect = () => rectangle(10, 20, 200, 100); hit.getBoundingClientRect = () => rectangle(180, 20, 30, 20);
    const anchor = anchorForHtmlNode(source, scope, preview.targets, { element: hit, x: 205, y: 25, capturedAt: '2026-10-17T12:00:00Z' })!;
    expect(anchor.element?.tag).toBe('section'); expect(anchor.element?.point).toEqual({ x: .975, y: .05 });
    expect(anchor.element?.pointer).toMatchObject({ area: 'top-right corner', insideTarget: true, client: { x: 205, y: 25 }, targetBox: { left: 10, top: 20, width: 200, height: 100 }, hit: { tag: 'span', text: 'Start now', box: { left: 180, top: 20, width: 30, height: 20 } } });
    expect(anchor.element?.pointer?.hit.sourceStart).toBe(source.indexOf('<span>'));
    expect(pointerArea(-.1, .4)).toBe('outside selected target');
  });
  it('selects the comment for a clicked HTML element and removes resolved highlights', async () => {
    const preview = htmlPreview(source, 'test'), target = preview.targets.find(t => t.element.attributes.id === 'go')!;
    const note = { id: 'button-note', body: 'Discuss this button', status: 'open' as const, anchor: makeHtmlAnchor(source, target.key), replies: [], createdAt: '' };
    const onPick = vi.fn(), onDeselect = vi.fn(), props = { id: 'test', content: source, comments: [note], changes: [], active: '', draft: null, onComment: () => {}, onPick, onDeselect };
    const view = render(<HtmlDocument {...props} />), frame = view.getByTitle('HTML document preview') as HTMLIFrameElement, doc = frame.contentDocument!;
    await act(async () => { doc.open(); doc.write(preview.html); doc.close(); }); frame.contentWindow!.scrollTo = () => {}; fireEvent.load(frame);
    await waitFor(() => expect(view.container.querySelector('.dr-html-target-passive')).toBeTruthy());
    fireEvent.click(doc.querySelector('#go span')!); expect(onPick).toHaveBeenLastCalledWith('button-note'); expect(onDeselect).toHaveBeenCalled();
    onPick.mockClear(); view.rerender(<HtmlDocument {...props} comments={[{ ...note, status: 'resolved' }]} />);
    await waitFor(() => expect(view.container.querySelector('.dr-html-target-passive')).toBeNull());
    fireEvent.click(doc.querySelector('#go span')!); expect(onPick).not.toHaveBeenCalled();
  });
  it('reuses parsed targets and a bounded diff through comment menus, selection and scroll, then disposes listeners', async () => {
    const content = '<main>' + Array.from({ length: 400 }, (_, i) => `<p id="p${i}">Paragraph ${i} new words.</p>`).join('') + '</main>';
    const change = { id: 'c', start: 0, end: content.length, before: content.replaceAll('new words', 'old text'), after: content, decision: 'pending' as const };
    const diff = vi.spyOn(model, 'computeChanges'), anchor = vi.spyOn(htmlDocument, 'makeHtmlAnchor');
    const props = { id: 'test', content, comments: [], changes: [change], active: '', draft: null, onComment: vi.fn(), onDeselect: vi.fn() };
    const view = render(<HtmlDocument {...props} />), frame = view.getByTitle('HTML document preview') as HTMLIFrameElement, doc = frame.contentDocument!, win = frame.contentWindow!;
    await act(async () => { doc.open(); doc.write(htmlPreview(content, 'test').html); doc.close(); }); win.scrollTo = () => {};
    const added = vi.spyOn(win, 'addEventListener'), removed = vi.spyOn(win, 'removeEventListener'); fireEvent.load(frame);
    const calls = diff.mock.calls.length; expect(calls).toBe(1); expect(diff.mock.calls[0]![2]).toBe(24);
    fireEvent.contextMenu(doc.querySelector('p')!, { clientX: 10, clientY: 10 });
    expect(anchor.mock.calls.length).toBeGreaterThan(0); expect(anchor.mock.calls.every(c => Array.isArray(c[6]) && c[6]!.length > 400)).toBe(true);
    view.rerender(<HtmlDocument {...props} active="another-card" />);
    await act(async () => { for (let i = 0; i < 20; i++) doc.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 40)); });
    expect(diff.mock.calls.length).toBe(calls);
    const resize = added.mock.calls.find(c => c[0] === 'resize')![1]; view.unmount();
    expect(removed.mock.calls.some(c => c[0] === 'resize' && c[1] === resize)).toBe(true);
  });
  it('keeps hundreds of offscreen comments out of the overlay DOM', async () => {
    const content = '<main>' + Array.from({ length: 400 }, (_, i) => `<p id="p${i}">Comment area ${i}.</p>`).join('') + '</main>', preview = htmlPreview(content, 'test');
    const comments = preview.targets.filter(t => t.element.tag === 'p').map((t, i) => ({ id: `n${i}`, body: 'Feedback', status: 'open' as const, anchor: makeHtmlAnchor(content, t.key, undefined, undefined, undefined, undefined, preview.targets), replies: [], createdAt: '' }));
    const view = render(<HtmlDocument id="test" content={content} comments={comments} changes={[]} active="" draft={null} onComment={() => {}} onDeselect={() => {}} />);
    const frame = view.getByTitle('HTML document preview') as HTMLIFrameElement, doc = frame.contentDocument!;
    await act(async () => { doc.open(); doc.write(preview.html); doc.close(); }); frame.contentWindow!.scrollTo = () => {};
    Array.from(doc.querySelectorAll('p')).forEach((p, i) => { p.getBoundingClientRect = () => rectangle(0, i * 100, 400, 40); });
    fireEvent.load(frame);
    await waitFor(() => { const count = view.container.querySelectorAll('.dr-html-target-passive').length; expect(count).toBeGreaterThan(0); expect(count).toBeLessThanOrEqual(8); });
  });
  it('uses highlighted HTML text immediately from the HTML comment shortcut, including after parent focus', async () => {
    const onComment = vi.fn(), ref = createRef<RichDocumentHandle>();
    const view = render(<HtmlDocument ref={ref} id="test" content={source} comments={[]} changes={[]} active="" draft={null} onComment={onComment} onDeselect={() => {}} />);
    const frame = view.getByTitle('HTML document preview') as HTMLIFrameElement, doc = frame.contentDocument!;
    await act(async () => { doc.open(); doc.write(htmlPreview(source, 'test').html); doc.close(); });
    frame.contentWindow!.scrollTo = () => {};
    fireEvent.load(frame);
    await waitFor(() => expect(ref.current).toBeTruthy());
    const text = doc.querySelector('strong')!.firstChild!, range = doc.createRange(); range.setStart(text, 0); range.setEnd(text, 9);
    await act(async () => { doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range); doc.dispatchEvent(new Event('selectionchange')); });
    // Toolbar focus may collapse the live selection; the saved selection must survive.
    doc.getSelection()!.removeAllRanges();
    await act(async () => { ref.current!.startComment!(); });
    expect(onComment).toHaveBeenCalledOnce();
    const anchor = onComment.mock.calls[0]![0]; expect(anchor.quote).toBe('your plan'); expect(anchor.element.selectedText).toBe('your plan'); expect(anchor.element.textRange).toEqual({ start: 0, end: 9 });
    expect(view.queryByRole('status')).toBeNull();
  });
});
