// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import app from './app';
import { makeAnchor } from './model';
import { sessionFixture } from './fixtures';
import { committedContent, acceptAllChanges, decideChange, editUntrackedDocument, editDocument, proposeDocument } from './review-state';

beforeAll(() => {
  const rect = () => ({ top: 100, bottom: 120, left: 150, right: 200, width: 50, height: 20, x: 150, y: 100, toJSON: () => ({}) });
  Range.prototype.getBoundingClientRect = rect as any; Range.prototype.getClientRects = (() => [rect()]) as any;
  HTMLElement.prototype.getBoundingClientRect = (() => ({ ...rect(), top: 0, bottom: 1000, height: 1000, width: 1000 })) as any;
  HTMLElement.prototype.scrollIntoView = () => {}; HTMLElement.prototype.scrollTo = () => {}; window.scrollTo = () => {}; window.scrollBy = () => {};
});
const disposals: (() => void)[] = []; afterEach(() => disposals.splice(0).forEach(f => f()));
async function mount(configure?: (s: ReturnType<typeof sessionFixture>) => void, overrides: Record<string, (p: any) => unknown> = {}) {
  const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
  let s = sessionFixture('Hello old world.\n'); proposeDocument(s, 'Hello new world.\n'); configure?.(s);
  const slot = renderSlot(definition.navPanels[0]!, { subPath: s.id }, { rpc: {
    list: () => [], activate: () => ({ pruned: 0 }), get: () => structuredClone(s), history: () => [],
    edit: (p: any) => { if (p.trackChanges ?? s.trackChanges) proposeDocument(s, p.content, 'user'); else { editUntrackedDocument(s, p.content); s.diskContent = committedContent(s); } s.revision++; return structuredClone(s); },
    tracking: (p: any) => { s.trackChanges = p.enabled; s.revision++; return structuredClone(s); },
    reply: (p: any) => { const c = s.comments.find(c => c.id === p.commentId)!; c.replies.push({ body: p.body, author: { kind: 'user', name: 'User' }, createdAt: new Date().toISOString() }); c.status = 'addressed'; c.resolvedAt = null; s.revision++; return structuredClone(s); },
    deleteComment: (p: any) => { s.comments = s.comments.filter(c => c.id !== p.commentId); s.revision++; return structuredClone(s); },
    clearHistory: () => { s.comments = s.comments.filter(c => c.status !== 'resolved'); s.revision++; return structuredClone(s); },
    commentStatus: (p: any) => { const c = s.comments.find(c => c.id === p.commentId)!; c.status = p.status; s.revision++; return structuredClone(s); },
    acceptAll: () => { acceptAllChanges(s); s.diskContent = s.content; s.revision++; return structuredClone(s); },
    decide: (p: any) => { decideChange(s, p.changeId, p.decision); if (p.decision === 'accepted') s.diskContent = committedContent(s); s.revision++; return structuredClone(s); },
    save: () => { s.revision++; return structuredClone(s); },
    comment: (p: any) => { s.comments.push({ id: 'note_new', body: p.body, author: { kind: 'user', name: 'User' }, anchor: p.anchor, status: 'open', replies: [], createdAt: new Date().toISOString() }); s.revision++; return structuredClone(s); },
    ...overrides,
  } });
  disposals.push(() => slot.lifecycle.unmount());
  await waitFor(() => expect(slot.container.querySelector('.ProseMirror')?.textContent).toContain('Hello'));
  const editor = (slot.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
  return { definition, slot, editor, session: () => s };
}
const roundtripRoot = process.cwd() + '/test-fixtures/markdown-roundtrip/';
const roundtripFixtures = readdirSync(roundtripRoot).map(name => ({ name, source: readFileSync(roundtripRoot + name, 'utf8') }));
describe('Docs-style review UI', () => {
  it('registers the editor in BB and has one document with a unified sidebar', async () => {
    const { definition, slot } = await mount(); expect(definition.fileOpeners[0]!.extensions).toContain('md'); expect(definition.threadPanelActions).toHaveLength(1);
    expect(slot.container.querySelector('[contenteditable=true]')).toBeTruthy(); expect(slot.queryByRole('tablist')).toBeNull();
    expect(slot.getByRole('complementary', { name: 'Comments and suggestions' })).toBeTruthy();
    expect(slot.container.querySelectorAll('.dr-toolbar')).toHaveLength(1); expect(slot.container.querySelector('.dr-edit-toolbar')).toBeNull();
    expect(slot.queryByRole('button', { name: 'Help' })).toBeNull(); expect(slot.queryByRole('button', { name: '+ Comment' })).toBeNull(); expect(definition.settingsSections).toHaveLength(1);
    expect(slot.queryByText('↑ Previous')).toBeNull(); expect(slot.queryByText('Accept remaining')).toBeNull();
  });
  it.each(roundtripFixtures)('does not rewrite $name on load/checkpoint or a nearby rich edit', async ({ source }) => {
    const initial = '# Hello fixture\n\n' + source;
    const { slot, editor, session } = await mount(s => { s.content = initial; s.diskContent = initial; s.changes = []; s.trackChanges = false; });
    fireEvent.keyDown(editor.view.dom, { key: 's', ctrlKey: true });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(session().content).toBe(initial); expect(session().diskContent).toBe(initial);
    expect(slot.rpcCalls.filter(c => c.method === 'edit')).toHaveLength(0);
    let at = -1; editor.state.doc.descendants((n, pos) => { if (n.isText && n.text!.includes('Edit this sentence.')) at = pos + n.text!.indexOf('Edit this sentence.'); });
    expect(at).toBeGreaterThan(0);
    await act(async () => { editor.commands.insertContentAt({ from: at, to: at + 19 }, 'Edit this paragraph.'); });
    fireEvent.keyDown(editor.view.dom, { key: 's', ctrlKey: true });
    await waitFor(() => expect(session().diskContent).toBe(initial.replace('Edit this sentence.', 'Edit this paragraph.')));
    expect(session().changes).toHaveLength(0);
  });
  it('accepts every pending suggestion from the sidebar while preserving comments and buffered typing', async () => {
    const { slot, editor, session } = await mount(s => { proposeDocument(s, s.content + '\nAnother pending paragraph.\n'); s.comments.push({ id: 'n', body: 'Keep discussing this', anchor: null, status: 'open', replies: [], createdAt: '' }); });
    expect(session().changes.length).toBeGreaterThan(1);
    await act(async () => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Buffered typing.'); });
    fireEvent.click(slot.getByRole('button', { name: 'Accept all changes' }));
    await waitFor(() => expect(session().changes).toHaveLength(0));
    expect(session().diskContent).toContain('Buffered typing.'); expect(session().diskContent).toBe(session().content);
    expect(session().comments[0]!.status).toBe('open'); expect(slot.getByRole('button', { name: 'Accept all changes' }).hasAttribute('disabled')).toBe(true);
  });
  it('ignores other reviews and avoids global inventory scans when editing or refocusing a document', async () => {
    const { slot, session } = await mount();
    expect(slot.rpcCalls.some(c => c.method === 'list')).toBe(false);
    const gets = () => slot.rpcCalls.filter(c => c.method === 'get').length, initial = gets();
    await slot.emitRealtime('changed', { id: 'another-review', revision: 500 });
    await slot.emitRealtime('changed', { id: session().id, revision: session().revision }); expect(gets()).toBe(initial);
    await slot.emitRealtime('changed', { id: session().id, revision: session().revision + 1 }); await waitFor(() => expect(gets()).toBeGreaterThan(initial));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(slot.rpcCalls.some(c => c.method === 'activate' || c.method === 'list')).toBe(false);
  });
  it('catches up a newer revision received while a coalesced refresh is in flight', async () => {
    let current: ReturnType<typeof sessionFixture>, hold = false, release: ((s: ReturnType<typeof sessionFixture>) => void) | undefined;
    const { slot } = await mount(s => { current = s; }, { get: () => hold ? new Promise(resolve => { release = resolve; }) : structuredClone(current!) });
    hold = true; await slot.emitRealtime('changed', { id: current!.id, revision: current!.revision + 1 });
    await waitFor(() => expect(release).toBeTruthy()); const intermediate = structuredClone(current!); intermediate.revision++;
    current!.revision += 2; current!.content += '\nHello latest revision.\n';
    await slot.emitRealtime('changed', { id: current!.id, revision: current!.revision }); hold = false;
    await act(async () => { release!(intermediate); });
    await waitFor(() => expect(slot.container.querySelector('.ProseMirror')?.textContent).toContain('Hello latest revision.'));
  });
  it('has no Save control and dismisses an accepted suggestion', async () => {
    const { slot, session } = await mount(); const pending = structuredClone(session().changes);
    expect(slot.queryByRole('button', { name: 'Save' })).toBeNull(); expect(session().changes).toEqual(pending);
    fireEvent.click(slot.getByText('✓ Accept'));
    await waitFor(() => expect(slot.queryByText('Suggested edit')).toBeNull()); expect(session().changes).toHaveLength(0);
  });
  it('hides the review sidebar and reopens it when starting a selected-text comment', async () => {
    const { slot, editor } = await mount();
    fireEvent.click(slot.getByRole('button', { name: 'Hide review' }));
    expect(slot.queryByRole('complementary')).toBeNull();
    expect(slot.container.querySelector('.dr-workspace.dr-sidebar-hidden')).toBeTruthy();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    fireEvent.click(within(document.querySelector('[aria-label="Selection formatting"]') as HTMLElement).getByRole('button', { name: 'Comment' }));
    expect(slot.getByRole('complementary', { name: 'Comments and suggestions' })).toBeTruthy();
    const input = await slot.findByRole('textbox', { name: 'New comment' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(slot.getByRole('button', { name: 'Hide review' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('keeps a decided card briefly inert for its fade/slide, then removes it', async () => {
    const { slot, session } = await mount();
    fireEvent.click(slot.getByText('× Reject'));
    await waitFor(() => expect(session().changes).toHaveLength(0));
    const exiting = slot.container.querySelector('.dr-flow-exit');
    expect(exiting?.getAttribute('aria-hidden')).toBe('true'); expect(exiting?.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(slot.container.querySelector('.dr-flow-exit')).toBeNull());
  });
  it('deletes an individual comment and its document decoration while keeping pending changes', async () => {
    const { slot, session } = await mount(s => s.comments.push({ id: 'n', body: 'Delete this thread', anchor: makeAnchor(s.content, 6, 9), status: 'open', replies: [], createdAt: '' }));
    fireEvent.click(slot.getByRole('button', { name: 'Comment Open' }));
    fireEvent.click(slot.getByRole('button', { name: /^Delete$/ }));
    expect(session().comments).toHaveLength(1);
    fireEvent.click(slot.getByRole('button', { name: 'Cancel' })); expect(session().comments).toHaveLength(1);
    fireEvent.click(slot.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(slot.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(session().comments).toHaveLength(0));
    expect(session().changes).toHaveLength(1); expect(document.querySelector('[data-comment-id="n"]')).toBeNull();
  });
  it('reopens the sidebar and selects the comment clicked in the document', async () => {
    const { slot } = await mount(s => s.comments.push({ id: 'n', body: 'Find me in sidebar', anchor: makeAnchor(s.content, 10, 15), status: 'open', replies: [], createdAt: '' }));
    fireEvent.click(slot.getByRole('button', { name: 'Hide review' }));
    window.getSelection()?.removeAllRanges();
    fireEvent.click(document.querySelector('[data-comment-id="n"]')!);
    await waitFor(() => expect(slot.getByRole('button', { name: 'Hide review' }).getAttribute('aria-expanded')).toBe('true'));
    expect(document.querySelector('[data-sidebar-item="n"]')?.classList.contains('dr-active-card')).toBe(true);
  });
  it('offers Clear history only in History and preserves active comments and suggestions', async () => {
    const { slot, session } = await mount(s => {
      for (const status of ['open', 'resolved'] as const) s.comments.push({ id: status, body: status + ' note', status, anchor: null, replies: [], createdAt: '' });
    });
    expect(slot.queryByRole('button', { name: 'Clear history' })).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'History' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(session().comments.map(c => c.status)).toEqual(['open']));
    expect(session().changes).toHaveLength(1);
    await waitFor(() => expect(slot.queryByText('resolved note')).toBeNull());
    expect(slot.getByRole('button', { name: 'Clear history' }).hasAttribute('disabled')).toBe(true);
  });
  it('offers contextual formatting and focuses an anchored comment in the shared sidebar', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    const bar = within(document.querySelector('[aria-label="Selection formatting"]') as HTMLElement);
    fireEvent.click(bar.getByRole('button', { name: 'Comment' }));
    const input = await slot.findByRole('textbox', { name: 'New comment' }); await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'Make this clearer' } }); fireEvent.click(slot.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(session().comments).toHaveLength(1)); expect(session().comments[0]!.anchor?.quote).toBe('new');
    expect(slot.getByText('Suggested edit')).toBeTruthy(); expect(slot.getByText('Make this clearer')).toBeTruthy();
  });
  it('clears the active comment on a document click and removes all of its decoration on Resolve', async () => {
    const { slot, editor, session } = await mount(s => s.comments.push({ id: 'n', body: 'Discuss this wording', anchor: makeAnchor(s.content, 6, 9), status: 'open', replies: [], createdAt: '' }));
    const heading = slot.getByRole('button', { name: 'Comment Open' }); fireEvent.click(heading);
    await waitFor(() => expect(slot.container.querySelector('.dr-comment-focused')).toBeTruthy());
    fireEvent.pointerDown(editor.view.dom, { button: 0 });
    await waitFor(() => expect(slot.container.querySelector('.dr-comment-focused')).toBeNull());
    fireEvent.click(heading); await waitFor(() => expect(slot.container.querySelector('.dr-comment-focused')).toBeTruthy());
    fireEvent.click(slot.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(session().comments[0]!.status).toBe('resolved'));
    await waitFor(() => expect(slot.container.querySelector('[data-comment-id="n"]')).toBeNull());
  });
  it('places the focused new-comment draft between surrounding comments and keeps its target visible', async () => {
    const { slot, editor } = await mount(s => { for (const [id, start, end] of [['above', 0, 5], ['below', 10, 15]] as const) s.comments.push({ id, body: id, anchor: makeAnchor(s.content, start, end), status: 'open', replies: [], createdAt: '' }); });
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    fireEvent.click(within(document.querySelector('[aria-label="Selection formatting"]') as HTMLElement).getByRole('button', { name: 'Comment' }));
    const input = await slot.findByRole('textbox', { name: 'New comment' }); await waitFor(() => expect(document.activeElement).toBe(input));
    const ids = Array.from(slot.container.querySelectorAll('[data-sidebar-item]')).map(e => e.getAttribute('data-sidebar-item'));
    expect(ids.indexOf('above')).toBeLessThan(ids.indexOf('__draft')); expect(ids.indexOf('__draft')).toBeLessThan(ids.indexOf('below'));
    expect(slot.container.querySelector('.dr-draft-target')?.textContent).toBe('new');
  });
  it('uses Cmd/Ctrl+Enter to post comments and replies while Enter keeps a new line', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    const bar = document.querySelector('[aria-label="Selection formatting"]') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: 'Comment' }));
    const input = await slot.findByRole('textbox', { name: 'New comment' });
    fireEvent.change(input, { target: { value: 'One line\nAnother line' } }); fireEvent.keyDown(input, { key: 'Enter' });
    expect(session().comments).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(session().comments).toHaveLength(1)); expect(session().comments[0]!.body).toBe('One line\nAnother line');
    expect(slot.getByText('You')).toBeTruthy();
    fireEvent.click(slot.getByRole('button', { name: 'Reply' })); const reply = await slot.findByRole('textbox', { name: 'Comment reply' });
    fireEvent.change(reply, { target: { value: 'Follow up' } }); fireEvent.keyDown(reply, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(session().comments[0]!.replies).toHaveLength(1));
  });
  it('resizes the review area with keyboard controls and shows authors for each participant', async () => {
    const { slot } = await mount(s => s.comments.push({ id: 'agent-note', body: 'Agent observation', anchor: null, status: 'open', author: { kind: 'agent', name: 'Codex', threadId: 't1', threadTitle: 'Review design' }, replies: [{ body: 'User response', createdAt: '', author: { kind: 'user', name: 'User' } }], createdAt: '' }));
    const divider = slot.getByRole('separator', { name: 'Resize review sidebar' });
    const before = Number(divider.getAttribute('aria-valuenow')); fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(before + 20);
    expect(slot.getByText('Agent · Codex')).toBeTruthy(); expect(slot.getByText('Review design')).toBeTruthy(); expect(slot.getByText('You')).toBeTruthy();
  });
  it('keeps the link editor alive through blur/decoration transactions and applies a bare domain to the original selection', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    fireEvent.click(within(document.querySelector('[aria-label="Selection formatting"]') as HTMLElement).getByRole('button', { name: 'Link' }));
    const input = await within(document.body).findByRole('textbox', { name: 'Link URL' });
    await act(async () => { input.focus(); editor.view.dispatch(editor.state.tr); });
    expect(document.body.contains(input)).toBe(true);
    fireEvent.change(input, { target: { value: 'example.com/plan' } }); fireEvent.click(within(document.body).getByRole('button', { name: 'Apply link' }));
    await waitFor(() => expect(session().content).toContain('[new](https://example.com/plan)'), { timeout: 2000 });
    expect(slot.container.querySelector('.ProseMirror a')?.getAttribute('href')).toBe('https://example.com/plan');
  });
  it('edits and removes an existing link from its caret popover and opens links with Cmd+K', async () => {
    const { slot, editor, session } = await mount(s => { s.content = 'Hello [linked](https://example.com).\n'; s.changes = []; });
    await act(async () => { editor.commands.setTextSelection(8); editor.commands.focus(); });
    const edit = await within(document.body).findByRole('button', { name: 'Edit link' }); fireEvent.click(edit);
    const input = await within(document.body).findByRole('textbox', { name: 'Link URL' }); fireEvent.change(input, { target: { value: 'new.example.com' } }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(session().content).toContain('https://new.example.com'));
    await act(async () => { editor.commands.setTextSelection(8); editor.commands.focus(); });
    fireEvent.keyDown(editor.view.dom, { key: 'k', code: 'KeyK', metaKey: true });
    expect(await within(document.body).findByRole('textbox', { name: 'Link URL' })).toBeTruthy();
    fireEvent.click(within(document.body).getByRole('button', { name: 'Cancel' }));
    await act(async () => { editor.commands.setTextSelection(8); editor.commands.focus(); });
    fireEvent.click(await within(document.body).findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(session().content).not.toContain('https://new.example.com'));
  });
  it('offers list-item and enclosing-list scopes for Markdown right-click comments', async () => {
    const { slot, editor } = await mount(s => { s.content = 'Hello.\n\n- First item\n- Second item\n'; s.changes = []; });
    fireEvent.contextMenu(editor.view.dom.querySelector('li p')!, { clientX: 175, clientY: 110 });
    const menu = await within(document.body).findByRole('menu', { name: 'Document actions' });
    expect(menu.textContent).toContain('List item'); expect(within(menu).getAllByRole('button').length).toBeGreaterThanOrEqual(2);
    const item = within(menu).getByRole('menuitem', { name: 'Comment here' }); fireEvent.pointerDown(item, { button: 0 }); fireEvent.click(item);
    expect(await slot.findByRole('textbox', { name: 'New comment' })).toBeTruthy(); expect(slot.container.querySelector('.dr-compose-comment .dr-quote')?.textContent).toBe('“First item”');
  });
  it('offers right-click block comments while allowing Shift + right-click to use the native menu', async () => {
    const { slot, editor, session } = await mount(); const paragraph = editor.view.dom.querySelector('p')!;
    fireEvent.contextMenu(paragraph, { clientX: 200, clientY: 130 });
    await within(document.body).findByRole('menuitem', { name: 'Comment here' });
    expect(slot.container.querySelector('.dr-draft-target')).toBeTruthy();
    const item = within(document.body).getByRole('menuitem', { name: 'Comment here' });
    fireEvent.pointerDown(item, { button: 0 }); fireEvent.mouseDown(item, { button: 0 }); fireEvent.pointerUp(item, { button: 0 }); fireEvent.click(item);
    fireEvent.change(slot.getByRole('textbox', { name: 'New comment' }), { target: { value: 'Discuss the whole paragraph' } }); fireEvent.click(slot.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(session().comments).toHaveLength(1));
    expect(session().comments[0]!.anchor?.element?.format).toBe('markdown'); expect(session().comments[0]!.anchor?.quote).toContain('Hello new world.');
    const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
    fireEvent(paragraph, native); expect(native.defaultPrevented).toBe(false);
  });
  it('comments on the complete visible Markdown selection even before the editor observes the final drag', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 9 }); editor.commands.focus(); });
    const p = editor.view.dom.querySelector('p')!, text = p.querySelector('.dr-insert')!.firstChild!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    fireEvent.contextMenu(p, { clientX: 175, clientY: 110 });
    const item = await within(document.body).findByRole('menuitem', { name: 'Comment here' }); fireEvent.pointerDown(item, { button: 0 }); fireEvent.click(item);
    const input = await slot.findByRole('textbox', { name: 'New comment' }); expect(slot.container.querySelector('.dr-compose-comment .dr-quote')?.textContent).toBe('“new”');
    fireEvent.change(input, { target: { value: 'Selected whole word' } }); fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(session().comments[0]?.anchor?.quote).toBe('new'));
  });
  it('uses the physical comment shortcut even when Option changes the key character', async () => {
    const { slot, editor } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    fireEvent.keyDown(editor.view.dom, { code: 'KeyM', key: 'µ', metaKey: true, altKey: true });
    expect(await slot.findByRole('textbox', { name: 'New comment' })).toBeTruthy();
  });
  it.each([1, 2, 3])('keeps the dropdown alive across native-popup blur for Heading %i and formats the original selection', async level => {
    const { slot, editor, session } = await mount(); const disk = session().diskContent;
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 16 }); editor.commands.focus(); });
    let select = await within(document.body).findByRole('combobox', { name: 'Paragraph style' });
    fireEvent.pointerDown(select, { button: 0 }); fireEvent.mouseDown(select, { button: 0 });
    // A native popup can blur the editor before the select becomes active.
    await act(async () => { editor.commands.blur(); await new Promise(r => setTimeout(r, 90)); });
    expect(document.body.contains(select)).toBe(true);
    fireEvent.change(select, { target: { value: `h${level}` } });
    await waitFor(() => expect(session().content).toMatch(new RegExp('^' + '#'.repeat(level) + ' Hello new world')));
    expect(editor.state.doc.firstChild?.type.name).toBe('heading'); expect(editor.state.doc.firstChild?.attrs.level).toBe(level); expect(editor.state.doc.firstChild?.textContent).toBe('Hello new world.'); expect(session().diskContent).toBe(disk);
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 16 }); editor.commands.focus(); });
    select = await within(document.body).findByRole('combobox', { name: 'Paragraph style' }); fireEvent.change(select, { target: { value: 'paragraph' } });
    await waitFor(() => expect(session().content.trim()).toBe('Hello new world.'));
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    fireEvent.pointerDown(slot.getByRole('button', { name: 'History' }), { button: 0 });
    await waitFor(() => expect(within(document.body).queryByRole('toolbar', { name: 'Selection formatting' })).toBeNull());
  });
  it('switches raw/rich without changing source and keeps raw deletions pending until accepted', async () => {
    const { slot, session } = await mount(); const disk = session().diskContent;
    fireEvent.click(slot.getByRole('button', { name: 'View: Rich' }));
    expect(slot.queryByRole('group', { name: 'Markdown view' })).toBeNull();
    expect(slot.getByRole('button', { name: 'View: Raw' })).toBeTruthy();
    const raw = slot.getByRole('textbox', { name: 'Raw Markdown' }) as HTMLTextAreaElement;
    expect(raw.value).toBe(session().content);
    fireEvent.change(raw, { target: { value: '---\ncustom: yes\n---\n\nHello new world.\n\n| A | B |\n| - | - |\n| keep | row |\n' } });
    // Switch before the typing debounce: optimistic content must survive unmount.
    fireEvent.click(slot.getByRole('button', { name: 'View: Raw' }));
    await waitFor(() => expect(slot.container.querySelector('.ProseMirror table')?.textContent).toContain('keep'));
    await waitFor(() => expect(session().content).toContain('custom: yes'));
    expect(session().diskContent).toBe(disk);
    fireEvent.click(slot.getByRole('button', { name: 'View: Rich' }));
    const again = slot.getByRole('textbox', { name: 'Raw Markdown' }) as HTMLTextAreaElement;
    expect(again.value).toContain('| keep | row |');
    fireEvent.change(again, { target: { value: again.value.replace('| keep | row |\n', '') } });
    fireEvent.click(slot.getByRole('button', { name: 'Accept all changes' }));
    await waitFor(() => expect(session().changes).toHaveLength(0));
    expect(session().diskContent).toBe(session().content); expect(session().diskContent).not.toContain('| keep | row |');
  });
  it.each(['Delete', 'Backspace', 'text drag'])('removes selected complete table rows with %s, retaining tracking and rejection', async key => {
    const { slot, editor, session } = await mount(s => { const table = 'Hello table.\n\n| A | B |\n| - | - |\n| first | one |\n| second | two |\n'; s.content = table; s.diskContent = table; s.changes = []; });
    let first = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'first') first = pos; });
    await act(async () => { editor.commands.setTextSelection(first); editor.view.focus(); });
    const controls = await slot.findByRole('toolbar', { name: 'Table editing' });
    if (key === 'text drag') { let end = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'one') end = pos + 3; }); await act(async () => { editor.commands.setTextSelection({ from: first, to: end }); }); } else { fireEvent.click(within(controls).getByRole('button', { name: 'Select row' })); expect(editor.view.dom.querySelectorAll('.selectedCell').length).toBe(2); }
    fireEvent.keyDown(editor.view.dom, { key: key === 'text drag' ? 'Delete' : key });
    await waitFor(() => expect(session().content).not.toContain('first'));
    expect(session().content).toContain('second'); expect(session().diskContent).toContain('first');
    expect(editor.view.dom.querySelectorAll('tr').length).toBe(2);
    while (session().changes.length) { const id = session().changes[0]!.id, revision = session().revision; const card = slot.container.querySelector(`[data-sidebar-item="${id}"]`)!; fireEvent.click(within(card as HTMLElement).getByText('× Reject')); await waitFor(() => expect(session().revision).toBeGreaterThan(revision)); }
    await waitFor(() => expect(editor.view.dom.querySelectorAll('tr').length).toBe(3));
    expect(session().content).toBe(session().diskContent);
  });
  it('serializes direct rich formatting without a source-mode tab', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.focus(); });
    await waitFor(() => expect(document.querySelector('[aria-label="Selection formatting"]')).toBeTruthy());
    fireEvent.click(within(document.querySelector('[aria-label="Selection formatting"]') as HTMLElement).getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(session().content).toContain('**new**'), { timeout: 2000 });
    expect(slot.container.querySelector('.ProseMirror strong')?.textContent).toBe('new');
  });
  it('tracks personal edits, keeps pending suggestions when toggled off, and applies future typing directly', async () => {
    const { slot, editor, session } = await mount();
    expect(slot.getByRole('switch', { name: 'Track changes: On' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.'); });
    await waitFor(() => expect(session().changes.some(c => c.source === 'user')).toBe(true));
    fireEvent.click(slot.getByRole('switch', { name: 'Track changes: On' }));
    await slot.findByRole('switch', { name: 'Track changes: Off' }); const pending = session().changes.length;
    await act(async () => { editor.commands.insertContentAt(1, 'Direct '); });
    await waitFor(() => expect(session().content).toContain('Direct Hello'));
    expect(session().changes).toHaveLength(pending);
  });
  it.each(['rich', 'raw'])('applies mixed proposed/native deletion immediately with tracking off in %s mode', async mode => {
    const { slot, editor, session } = await mount(s => { const text = 'Hello old world.\n\nKeep original ending.\n'; s.content = text; s.diskContent = text; s.changes = []; proposeDocument(s, text.replace('old', 'new').replace('original', 'proposed')); });
    const untouched = session().changes.at(-1)!.id;
    fireEvent.click(slot.getByRole('switch', { name: 'Track changes: On' }));
    await slot.findByRole('switch', { name: 'Track changes: Off' });
    if (mode === 'raw') {
      fireEvent.click(slot.getByRole('button', { name: 'View: Rich' }));
      fireEvent.change(slot.getByRole('textbox', { name: 'Raw Markdown' }), { target: { value: session().content.replace('new world', '') } });
    } else await act(async () => { editor.commands.setTextSelection({ from: 7, to: 16 }); editor.commands.deleteSelection(); });
    // Optimistic preview and persisted state use the same direct-edit policy.
    expect(slot.queryByText('Your edit')).toBeNull();
    await waitFor(() => expect(session().content).toContain('Hello .'));
    expect(session().diskContent).toContain('Hello .'); expect(session().diskContent).not.toContain('new');
    expect(session().diskContent).toContain('original ending');
    expect(session().changes.map(c => c.id)).toEqual([untouched]);
    expect(session().changes[0]!.source).toBe('agent');
    fireEvent.click(slot.getByRole('switch', { name: 'Track changes: Off' }));
    await slot.findByRole('switch', { name: 'Track changes: On' });
    expect(session().changes.map(c => c.id)).toEqual([untouched]);
  });
  it('can accept a new personal suggestion immediately, before the typing debounce', async () => {
    const { slot, editor, session } = await mount();
    await act(async () => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Own words.'); });
    const card = slot.getByText('Your edit').closest('section')!;
    fireEvent.click(within(card).getByText('✓ Accept'));
    await waitFor(() => expect(slot.queryByText('Your edit')).toBeNull());
    expect(session().content).toContain('Own words.'); expect(session().changes).toHaveLength(1); expect(slot.queryByRole('alert')).toBeNull();
  });
  it('outlines removed comment text in red and preserves its thread through reject, resolve, and reply', async () => {
    const { slot, editor, session } = await mount();
    session().comments.push({ id: 'note_delete', body: 'Keep this conversation', anchor: makeAnchor(session().content, 6, 9), status: 'open', replies: [], createdAt: new Date().toISOString() });
    await act(async () => { editor.commands.setTextSelection({ from: 7, to: 10 }); editor.commands.deleteSelection(); });
    await waitFor(() => expect(slot.queryByText('Keep this conversation')).toBeTruthy());
    fireEvent.click(slot.getByText('Keep this conversation').closest('section')!.querySelector('.dr-quote')!);
    await waitFor(() => expect(slot.container.querySelector('[data-comment-id="note_delete"].dr-comment-focused')).toBeTruthy());
    expect(slot.container.querySelector('.dr-comment-marker')?.textContent).toContain('Removed passage');
    // Flush, reject the combined original suggestion, and retain the same conversation.
    await waitFor(() => expect(session().comments[0]!.anchor?.removed).toBe(true));
    fireEvent.click(slot.getByText('× Reject'));
    await waitFor(() => expect(session().content).toBe('Hello old world.\n'));
    expect(session().comments[0]!.body).toBe('Keep this conversation'); expect(session().comments[0]!.anchor?.removed).toBe(false); await waitFor(() => expect(slot.container.querySelector('.dr-comment-marker')).toBeNull());
    fireEvent.click(slot.getByRole('button', { name: 'Resolve' })); await waitFor(() => expect(session().comments[0]!.status).toBe('resolved'));
    fireEvent.click(slot.getByRole('button', { name: 'History' })); await slot.findByRole('button', { name: 'Reopen' });
    fireEvent.click(slot.getByRole('button', { name: 'Reply' }));
    fireEvent.change(slot.getByRole('textbox', { name: 'Comment reply' }), { target: { value: 'Try again, please' } }); fireEvent.click(slot.getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(session().comments[0]!.status).toBe('addressed'));
    expect(await slot.findByText('Try again, please')).toBeTruthy(); expect(slot.getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });
  it('keeps initial/remote document loads out of typing undo and flushes typing on Ctrl+S', async () => {
    const { slot, editor, session } = await mount();
    const before = editor.getJSON(); await act(async () => { editor.commands.undo(); }); expect(editor.getJSON()).toEqual(before);
    await act(async () => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' My own words.'); });
    fireEvent.keyDown(editor.view.dom, { key: 's', ctrlKey: true });
    await waitFor(() => expect(session().content).toContain('My own words.'));
    expect(session().diskContent).not.toContain('My own words.'); expect(slot.inspection.rpcCalls.some(c => c.method === 'save')).toBe(false); expect(session().changes).toHaveLength(2);
  });
});
