import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse, makeHostResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { confined } from './server';
import { makeHtmlAnchor, parseHtml } from './html-document';
import { committedContent } from './review-state';
import { computeChanges } from './model';
import type { Session, HistoryEntry } from './model';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); vi.useRealTimers(); });
async function setup() {
  const files = new Map([['/docs/test.md', '# Test\n\nI like cats.\n\nYou like tea.\n'], ['/docs/draft.md', '# Test\n\nI love cats.\n\nYou like coffee.\n']]);
  const writes: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: 'document-review', sdk: { hosts: { list: async () => [makeHostResponse({ id: 'host-test', status: 'connected' })] }, files: {
    read: async ({ path }) => { const content = files.get(path); if (content === undefined) throw Object.assign(new Error('File not found'), { code: 'ENOENT' }); return { content, sha256: hash(content), sizeBytes: Buffer.byteLength(content), contentEncoding: 'utf8' as const }; },
    write: async args => { writes.push(args); const current = files.get(args.path); if ((current === undefined ? null : hash(current)) !== args.expectedSha256) return { outcome: 'conflict' as const, currentSha256: current === undefined ? null : hash(current) }; files.set(args.path, args.content); return { outcome: 'written' as const, sha256: hash(args.content), sizeBytes: Buffer.byteLength(args.content) }; },
  } } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  const call = async (name: string, args: unknown) => await harness.behavior.callRpc(name, args) as Session;
  const open = () => call('open', { path: '/docs/test.md', hostId: 'host-test' });
  const propose = (s: Session, content = files.get('/docs/draft.md')!) => call('propose', { id: s.id, revision: s.revision, content });
  return { bb, harness, call, open, propose, files, writes };
}
describe('editable review backend', () => {
  it('accepts a large mixed pending set with one conditional write, preserving comments and history', async () => {
    const { call, files, writes, harness } = await setup(); const original = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} has old wording and a stable ending.`).join('\n\n'); files.set('/docs/bulk.md', original);
    let s = await call('open', { path: '/docs/bulk.md', hostId: 'host-test' });
    s = await call('propose', { id: s.id, revision: s.revision, content: original.replaceAll('old wording', 'new wording') });
    expect(s.changes.length).toBeGreaterThan(50);
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content + '\nPersonal pending ending.\n', trackChanges: true });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Still relevant feedback', anchor: null });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Retain in History', anchor: null });
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: s.comments[1]!.id, status: 'resolved' });
    const pending = structuredClone(s.changes), content = s.content, comments = structuredClone(s.comments);
    await expect(call('acceptAll', { id: s.id, revision: s.revision - 1 })).rejects.toThrow(/changed/); expect(writes).toHaveLength(0);
    s = await call('acceptAll', { id: s.id, revision: s.revision });
    expect(writes).toHaveLength(1); expect(files.get(s.path)).toBe(content); expect(s.content).toBe(content); expect(s.changes).toEqual([]); expect(s.comments).toEqual(comments);
    const history = await harness.behavior.callRpc('history', { id: s.id }) as HistoryEntry[], item = history.find(e => e.summary === `Accepted all ${pending.length} changes`)!;
    const detail = await harness.behavior.callRpc('historyEntry', { id: s.id, eventId: item.id }) as HistoryEntry;
    expect(detail.changes).toEqual(pending.map(c => ({ ...c, decision: 'accepted' }))); expect(new Set(detail.changes!.map(c => c.source))).toEqual(new Set(['agent', 'user']));
    s = await call('acceptAll', { id: s.id, revision: s.revision }); expect(writes).toHaveLength(1);
  });
  it('keeps every pending change and comment event intact when accepting all fails to write', async () => {
    const { call, open, propose, harness, files } = await setup(); let s = await propose(await open());
    const start = s.content.indexOf('cats'); s = await call('comment', { id: s.id, revision: s.revision, body: 'Discuss this animal', anchor: { start, end: start + 4, quote: 'cats', prefix: '', suffix: '', orphaned: false } });
    const before = structuredClone(s), history = await harness.behavior.callRpc('history', { id: s.id });
    harness.sdk.stub('files.write', () => ({ outcome: 'conflict', currentSha256: hash('race') }));
    await expect(call('acceptAll', { id: s.id, revision: s.revision })).rejects.toThrow(/file changed/);
    expect(await call('get', { id: s.id })).toEqual(before); expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual(history); expect(files.get(s.path)).toBe(s.diskContent);
    harness.sdk.stub('files.write', () => { throw new Error('Host offline'); });
    await expect(call('acceptAll', { id: s.id, revision: s.revision })).rejects.toThrow(/offline/); expect(await call('get', { id: s.id })).toEqual(before);
  });
  it('keeps tracked review opt-in in the injected agent instructions', async () => {
    const { harness } = await setup(), instruction = harness.registrations.instructionProvider?.({ threadId: 't', projectId: 'p' })!;
    expect(instruction).toContain('only when the user asks'); expect(instruction).toContain('already existing Markdown'); expect(instruction).toContain('Do not use it for ordinary document creation, plan rewrites'); expect(instruction).toContain('An existing Markdown file or review alone is not an invocation');
  });
  it('checkpoints the review without writing pending text and commits only the accepted suggestion', async () => {
    const { call, open, propose, files, writes } = await setup(); const original = files.get('/docs/test.md')!; let s = await propose(await open());
    const pending = structuredClone(s.changes);
    s = await call('save', { id: s.id, revision: s.revision }); expect(files.get(s.path)).toBe(original); expect(writes).toHaveLength(0); expect(s.changes).toEqual(pending);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' });
    expect(files.get(s.path)).toBe(original.replace('like cats', 'love cats')); expect(files.get(s.path)).not.toContain('coffee'); expect(s.changes).toHaveLength(1); expect(s.dirty).toBe(false);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'rejected' });
    expect(writes).toHaveLength(1); expect(s.content).toBe(files.get(s.path));
  });
  it.each(['forward', 'reverse'])('writes only decided edits in %s order across insertion, deletion and replacement', async order => {
    const { call, files } = await setup(); const original = 'One alpha.\n\nTwo beta.\n\nThree gamma.\n'; files.set('/docs/order.md', original);
    let s = await call('open', { path: '/docs/order.md', hostId: 'host-test' }); const proposed = 'New intro.\n\nOne alpha.\n\nTwo changed.\n\n';
    s = await call('propose', { id: s.id, revision: s.revision, content: proposed }); expect(s.changes.length).toBeGreaterThanOrEqual(3);
    const ids = s.changes.map(c => c.id); if (order === 'reverse') ids.reverse();
    for (const id of ids) {
      s = await call('decide', { id: s.id, revision: s.revision, changeId: id, decision: 'accepted' });
      const remainingText = s.changes.map(c => ({ start: c.start, end: c.end, value: c.before })).sort((a, b) => b.start - a.start).reduce((text, c) => text.slice(0, c.start) + c.value + text.slice(c.end), s.content);
      expect(files.get(s.path)).toBe(remainingText); expect(s.content).toBe(proposed);
    }
    expect(files.get(s.path)).toBe(proposed);
  });
  it('holds tracked personal edits until accepted and automatically writes untracked edits', async () => {
    const { call, open, files, writes } = await setup(); let s = await open(); const original = s.content;
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content + '\nMy tracked paragraph.\n' });
    expect(files.get(s.path)).toBe(original); expect(writes).toHaveLength(0);
    s = await call('tracking', { id: s.id, revision: s.revision, enabled: false });
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('like tea', 'prefer tea') });
    expect(files.get(s.path)).toBe(original.replace('like tea', 'prefer tea')); expect(files.get(s.path)).not.toContain('My tracked'); expect(s.changes).toHaveLength(1);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' }); expect(files.get(s.path)).toContain('My tracked paragraph.');
  });
  it('writes direct edits to a pending replacement and leaves unrelated proposals pending', async () => {
    const { call, open, propose, files, harness } = await setup(); let s = await propose(await open()); const original = s.diskContent, untouched = s.changes[1]!.id;
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('love cats', 'adore cats'), trackChanges: false });
    expect(files.get(s.path)).toBe(original.replace('like cats', 'adore cats')); expect(s.changes.map(c => c.id)).toEqual([untouched]);
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: 'Direct heading.\n\n' + s.content, trackChanges: false });
    expect(files.get(s.path)).toBe('Direct heading.\n\n' + original.replace('like cats', 'adore cats')); expect(s.changes.map(c => c.id)).toEqual([untouched]);
    const history = await harness.behavior.callRpc('history', { id: s.id }) as { kind: string }[];
    expect(history.some(h => h.kind === 'edited')).toBe(true);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: untouched, decision: 'rejected' });
    expect(s.content).toBe(files.get(s.path)); expect(s.content).toContain('adore cats'); expect(s.content).not.toContain('coffee');
  });
  it('deletes across proposed and original text with tracking off and persists the result across reload', async () => {
    const { call, files, harness } = await setup(); files.set('/docs/mixed.md', 'Keep old passage.\n\nKeep original ending.\n');
    let s = await call('open', { path: '/docs/mixed.md', hostId: 'host-test' });
    s = await call('propose', { id: s.id, revision: s.revision, content: s.content.replace('old', 'new').replace('original', 'proposed') });
    const untouched = s.changes[1]!.id;
    s = await call('tracking', { id: s.id, revision: s.revision, enabled: false });
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('new passage', '') });
    expect(s.content).toBe('Keep .\n\nKeep proposed ending.\n');
    expect(files.get(s.path)).toBe('Keep .\n\nKeep original ending.\n'); expect(s.changes.map(c => c.id)).toEqual([untouched]);
    const resumed = await harness.lifecycle.reload(plugin); cleanups.push(() => resumed.harness.lifecycle.dispose());
    const restored = await resumed.harness.behavior.callRpc('get', { id: s.id }) as Session;
    expect(restored.content).toBe(s.content); expect(restored.changes).toEqual(s.changes); expect(restored.trackChanges).toBe(false);
  });
  it('persists personal tracking mode, preserves pending work when disabled, and always tracks agent edits', async () => {
    const { call, open, propose, harness } = await setup(); let s = await open(); expect(s.trackChanges).toBe(true);
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('cats', 'dogs') });
    const id = s.changes[0]!.id; expect(s.changes[0]!.source).toBe('user');
    s = await call('tracking', { id: s.id, revision: s.revision, enabled: false }); expect(s.changes[0]!.id).toBe(id);
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content + '\nUntracked paragraph.\n' });
    expect(s.changes).toHaveLength(1);
    s = await propose(s, s.content.replace('tea', 'coffee')); expect(s.changes).toHaveLength(2);
    const replacement = await harness.lifecycle.reload(plugin); cleanups.push(() => replacement.harness.lifecycle.dispose());
    const resumed = await replacement.harness.behavior.callRpc('get', { id: s.id }) as Session; expect(resumed.trackChanges).toBe(false); expect(resumed.changes).toEqual(s.changes);
  });
  it('preserves a conversation through tracked deletion, rejection, resolution, and a reopening reply', async () => {
    const { call, open } = await setup(); let s = await open(); const start = s.content.indexOf('cats');
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Replace this animal', anchor: { start, end: start + 4, quote: 'cats', prefix: '', suffix: '', orphaned: false } }); const note = s.comments[0]!.id;
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('cats', '') });
    expect(s.comments[0]!.anchor).toMatchObject({ removed: true, orphaned: false });
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'rejected' });
    expect(s.comments[0]!.replies.map(r => r.kind)).toEqual(['revision', 'rejected']); expect(s.comments[0]!.anchor?.removed).toBe(false);
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: note, status: 'resolved' });
    s = await call('reply', { id: s.id, revision: s.revision, commentId: note, body: 'Try another revision' });
    expect(s.comments[0]!.status).toBe('addressed'); expect(s.comments[0]!.resolvedAt).toBeNull();
    expect(s.comments[0]!.replies.map(r => r.kind)).toEqual(['revision', 'rejected', 'resolved', 'reply']); expect(s.comments[0]!.body).toBe('Replace this animal');
  });
  it('opens HTML, persists element references and exact source, and reviews each proposal atomically', async () => {
    const { call, files, harness } = await setup(); const source = '<!doctype html><main><button id="go">Go</button><p>Original</p></main>\n'; files.set('/docs/design.html', source);
    let s = await call('open', { path: '/docs/design.html', hostId: 'host-test' });
    const button = parseHtml(source).targets.find(t => t.element.tag === 'button')!;
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Make this blue', anchor: makeHtmlAnchor(source, button.key, { x: .4, y: .6 }) }); const noteId = s.comments[0]!.id;
    s = await call('save', { id: s.id, revision: s.revision }); expect(files.get(s.path)).toBe(source);
    const proposed = source.replace('>Go<', '>Begin<').replace('<p>Original</p>', '<aside>New note</aside>');
    s = await call('propose', { id: s.id, revision: s.revision, content: proposed }); expect(s.changes).toHaveLength(1); expect(s.comments[0]!.id).toBe(noteId); expect(s.comments[0]!.anchor?.orphaned).toBe(false);
    s = await call('save', { id: s.id, revision: s.revision }); expect(files.get(s.path)).toBe(source); expect(s.changes).toHaveLength(1); expect(files.get(s.path)).not.toContain('data-dr-');
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'rejected' }); expect(s.content).toBe(source); expect(s.comments[0]!.anchor?.element?.attributes.id).toBe('go');
    const resumed = await harness.lifecycle.reload(plugin); cleanups.push(() => resumed.harness.lifecycle.dispose());
    const saved = await resumed.harness.behavior.callRpc('get', { id: s.id }) as Session; expect(saved.comments[0]!.anchor?.element?.point).toEqual({ x: .4, y: .6 });
  });
  it('serves only confined preview assets and resolves nested stylesheet references', async () => {
    const { call, files, harness } = await setup(); files.set('/docs/design.htm', '<link rel="stylesheet" href="style.css"><img src="images/x.svg">'); files.set('/docs/style.css', 'body{background:url(images/x.svg)}'); files.set('/docs/images/x.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const s = await call('open', { path: '/docs/design.htm', hostId: 'host-test' });
    const css = await harness.behavior.fetchHttp('GET', `/asset?id=${s.id}&path=style.css`); expect(css.status).toBe(200); expect(await css.text()).toContain('path=images%2Fx.svg');
    files.set('/docs/controls.js', 'window.controlsLoaded=true;');
    const script = await harness.behavior.fetchHttp('GET', `/asset?id=${s.id}&path=controls.js`);
    expect(script.status).toBe(200); expect(script.headers.get('content-type')).toContain('text/javascript'); expect(script.headers.get('access-control-allow-origin')).toBe('*'); expect(await script.text()).toBe('window.controlsLoaded=true;');
    const escaped = await harness.behavior.fetchHttp('GET', `/asset?id=${s.id}&path=..%2Fsecret.css`); expect(escaped.status).toBe(404);
    const html = await harness.behavior.fetchHttp('GET', `/asset?id=${s.id}&path=design.htm`); expect(html.status).toBe(415);
  });
  it('archives accept/reject immediately and retains progress during another agent update', async () => {
    const { call, open, propose, harness } = await setup(); let s = await propose(await open()); const [a, b] = s.changes;
    s = await call('decide', { id: s.id, revision: s.revision, changeId: a!.id, decision: 'accepted' });
    s = await propose(s, s.content.replace('coffee', 'hot chocolate')); expect(s.changes[0]!.id).toBe(b!.id); expect(s.content).toContain('I love cats.');
    s = await call('decide', { id: s.id, revision: s.revision, changeId: b!.id, decision: 'rejected' });
    expect(s.changes).toHaveLength(0); expect(s.content).toContain('tea');
    const history = await harness.behavior.callRpc('history', { id: s.id }) as HistoryEntry[]; expect(history.map(h => h.kind)).toEqual(expect.arrayContaining(['accepted', 'rejected']));
  });
  it('attributes UI comments to the user and agent comments/replies to their originating thread across reload', async () => {
    const { call, files, harness } = await setup(); files.set('/docs/authors.html', '<main><button id="go">Start</button></main>');
    harness.sdk.stub('threads.get', () => makeThreadResponse({ providerId: 'codex', title: 'Check design' }));
    let s = await call('open', { path: '/docs/authors.html', hostId: 'host-test' });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Human note', anchor: null, author: { kind: 'agent', name: 'Spoofed' } });
    expect(s.comments[0]!.author).toEqual({ kind: 'user', name: 'User' });
    await harness.behavior.callAgentTool('document_review_comment', { id: s.id, revision: s.revision, body: 'Button needs contrast', anchor: null, selector: '#go' }, { threadId: 'design-agent' });
    s = await call('get', { id: s.id }); const note = s.comments[1]!;
    expect(note.author).toEqual({ kind: 'agent', name: 'Codex', threadId: 'design-agent', threadTitle: 'Check design' }); expect(note.anchor?.element?.attributes.id).toBe('go');
    await harness.behavior.callAgentTool('document_review_reply', { id: s.id, revision: s.revision, commentId: s.comments[0]!.id, body: 'Here is my response' }, { threadId: 'design-agent' });
    s = await call('get', { id: s.id }); expect(s.comments[0]!.replies[0]!.author?.kind).toBe('agent');
    s = await call('reply', { id: s.id, revision: s.revision, commentId: note.id, body: 'Please use the darker green' });
    expect(s.comments[1]!.replies.at(-1)!.author?.kind).toBe('user');
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: note.id, status: 'resolved' });
    await harness.behavior.callAgentTool('document_review_reply', { id: s.id, revision: s.revision, commentId: note.id, body: 'Updated and ready to review' }, { threadId: 'design-agent' });
    s = await call('get', { id: s.id }); expect(s.comments[1]!.status).toBe('addressed'); expect(s.comments[1]!.author).toEqual(note.author); expect(s.comments[1]!.replies.at(-1)!.author?.threadId).toBe('design-agent');
    const cli = await harness.behavior.runCli(['comment', s.id, '--body', 'CLI observation', '--selector', '#go', '--revision', String(s.revision), '--json']); expect(cli.exitCode).toBe(0);
    s = await call('get', { id: s.id }); expect(s.comments[2]!.author?.kind).toBe('agent'); expect(s.comments[2]!.anchor?.element?.attributes.id).toBe('go');
    const invalid = await harness.behavior.runCli(['comment', s.id, '--body', 'x'.repeat(20_001), '--revision', String(s.revision), '--json']); expect(invalid.exitCode).not.toBe(0);
    const replacement = await harness.lifecycle.reload(plugin); cleanups.push(() => replacement.harness.lifecycle.dispose());
    const restored = await replacement.harness.behavior.callRpc('get', { id: s.id }) as Session; expect(restored.comments).toEqual(s.comments);
  });
  it('excludes resolved comments from agent reads and permanently deletes all copies of a thread', async () => {
    const { call, open, harness, writes } = await setup(); let s = await open();
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Obsolete instruction', anchor: null }); const id = s.comments[0]!.id;
    s = await call('reply', { id: s.id, revision: s.revision, commentId: id, body: 'Old reply' });
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: id, status: 'resolved' });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Keep active', anchor: null });
    for (const args of [['get', s.id, '--json'], ['get', s.id, '--comments', '--json'], ['open', s.path, '--host', s.hostId, '--json']]) {
      const result = await harness.behavior.runCli(args); expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout!).comments.map((c: any) => c.body)).toEqual(['Keep active']);
    }
    const feedback = await harness.behavior.callAgentTool('document_review_feedback', { path: s.path, hostId: s.hostId });
    expect(JSON.stringify(feedback)).not.toContain('Obsolete instruction');
    const history = await harness.behavior.callRpc('history', { id: s.id }) as HistoryEntry[]; expect(history).toHaveLength(1);
    await expect(call('deleteComment', { id: s.id, revision: s.revision - 1, commentId: id })).rejects.toThrow();
    s = await call('deleteComment', { id: s.id, revision: s.revision, commentId: id }); expect(s.comments.map(c => c.body)).toEqual(['Keep active']);
    expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual([]);
    await expect(harness.behavior.callRpc('historyEntry', { id: s.id, eventId: history[0]!.id })).rejects.toThrow(); expect(writes).toHaveLength(0);
    const replacement = await harness.lifecycle.reload(plugin); cleanups.push(() => replacement.harness.lifecycle.dispose());
    const restored = await replacement.harness.behavior.callRpc('get', { id: s.id }) as Session; expect(restored.comments.map(c => c.body)).toEqual(['Keep active']);
  });
  it('clears only this document history and resolved threads, preserving content and pending work through reload', async () => {
    const { call, open, propose, harness, files } = await setup(); let s = await propose(await open());
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Keep this active', anchor: null });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Finished conversation', anchor: null });
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: s.comments[1]!.id, status: 'resolved' });
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' });
    files.set('/docs/other.md', 'Other'); let other = await call('open', { path: '/docs/other.md', hostId: 'host-test' });
    other = await propose(other, 'Updated other'); other = await call('decide', { id: other.id, revision: other.revision, changeId: other.changes[0]!.id, decision: 'rejected' });
    const historyBefore = await harness.behavior.callRpc('history', { id: other.id });
    const content = s.content, pending = structuredClone(s.changes);
    await expect(call('clearHistory', { id: s.id, revision: s.revision - 1 })).rejects.toThrow();
    s = await call('clearHistory', { id: s.id, revision: s.revision });
    expect(s.content).toBe(content); expect(s.changes).toEqual(pending); expect(s.comments.map(c => c.body)).toEqual(['Keep this active']);
    expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual([]);
    expect(await harness.behavior.callRpc('history', { id: other.id })).toEqual(historyBefore);
    const replacement = await harness.lifecycle.reload(plugin); cleanups.push(() => replacement.harness.lifecycle.dispose());
    expect(await replacement.harness.behavior.callRpc('get', { id: s.id })).toMatchObject({ content, changes: pending, comments: s.comments });
    expect(await replacement.harness.behavior.callRpc('history', { id: s.id })).toEqual([]);
  });
  it('discovers feedback outside chat through path, workspace, CLI and a native tool without opening new reviews', async () => {
    const { call, open, harness } = await setup(); let s = await open();
    for (let i = 0; i < 12; i++) s = await call('comment', { id: s.id, revision: s.revision, body: 'Feedback ' + i, anchor: null });
    s = await call('commentStatus', { id: s.id, revision: s.revision, commentId: s.comments[0]!.id, status: 'resolved' });
    const args = { path: s.path, hostId: s.hostId };
    const first: any = await harness.behavior.callRpc('feedback', args);
    expect(first.reviews[0]).toMatchObject({ id: s.id, revision: s.revision, unresolvedComments: 11, nextCommentOffset: 10 });
    expect(first.reviews[0].comments).toHaveLength(10); expect(first.reviews[0].comments[0].body).toBe('Feedback 1');
    const last: any = await harness.behavior.callRpc('feedback', { ...args, offset: 10 }); expect(last.reviews[0].comments).toHaveLength(1); expect(last.reviews[0].nextCommentOffset).toBeNull();
    harness.sdk.stub('threads.get', () => makeThreadResponse({ environmentId: 'env1' })); harness.sdk.stub('environments.get', () => ({ hostId: 'host-test', path: '/docs' }));
    const workspace: any = await harness.behavior.callRpc('feedback', { threadId: 'another-thread' }); expect(workspace.reviews[0].id).toBe(s.id); expect(workspace.reviews[0].comments).toEqual([]);
    const cli = await harness.behavior.runCli(['feedback', s.path, '--host', s.hostId, '--json']); expect(cli.exitCode).toBe(0); expect(JSON.parse(cli.stdout!).reviews[0].id).toBe(s.id);
    const tool = await harness.behavior.callAgentTool('document_review_feedback', args); expect(JSON.stringify(tool)).toContain('Feedback 1');
    expect(harness.registrations.instructionProvider?.({ threadId: 't', projectId: 'p' })).toContain('document_review_feedback');
    expect(await harness.behavior.callRpc('feedback', { path: '/docs/missing.md', hostId: s.hostId })).toEqual({ reviews: [], nextReviewOffset: null });
    expect(await harness.behavior.callRpc('list', null)).toHaveLength(1);
  });
  it('merges stale buffered typing with a new agent edit on a different passage', async () => {
    const { call, open, propose } = await setup(); const initial = await open(); let s = await propose(initial, initial.content.replace('tea', 'coffee'));
    s = await call('edit', { id: s.id, revision: initial.revision, baseContent: initial.content, content: initial.content.replace('like cats', 'prefer dogs') });
    expect(s.content).toContain('prefer dogs'); expect(s.content).toContain('coffee'); expect(s.changes).toHaveLength(2);
  });
  it('rejects stale agent proposals and overlapping concurrent typing without overwriting', async () => {
    const { call, open, propose } = await setup(); const initial = await open(); const s = await propose(initial);
    await expect(propose(initial, 'stale')).rejects.toThrow(/changed/);
    await expect(call('edit', { id: s.id, revision: initial.revision, baseContent: initial.content, content: initial.content.replace('like cats', 'hate cats') })).rejects.toThrow(/overlaps/);
    expect((await call('get', { id: s.id })).content).toBe(s.content);
  });
  it('reconciles external edits, removes overlapping suggestions and preserves unrelated pending work', async () => {
    const { call, open, propose, files } = await setup(); let s = await propose(await open()); const second = s.changes[1]!.id;
    files.set(s.path, s.diskContent.replace('like cats', 'adore cats'));
    s = await call('get', { id: s.id }); expect(s.content).toContain('adore cats'); expect(s.content).toContain('coffee'); expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(second);
    expect(s.notice).toContain('outside');
  });
  it('keeps pending decisions and history intact on write conflicts or offline failure', async () => {
    const { call, open, propose, harness, files } = await setup(); const s = await propose(await open()), beforeHistory = await harness.behavior.callRpc('history', { id: s.id });
    harness.sdk.stub('files.write', () => ({ outcome: 'conflict', currentSha256: hash('race') }));
    await expect(call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' })).rejects.toThrow(/file changed/);
    expect((await call('get', { id: s.id })).changes).toEqual(s.changes); expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual(beforeHistory);
    harness.sdk.stub('files.write', () => { throw new Error('Host offline'); });
    await expect(call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' })).rejects.toThrow(/offline/);
    expect((await call('get', { id: s.id })).revision).toBe(s.revision); expect(files.get(s.path)).toBe(s.diskContent);
    await expect(call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content + ' Untracked', trackChanges: false })).rejects.toThrow(/offline/);
    expect((await call('get', { id: s.id })).content).toBe(s.content); expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual(beforeHistory);
  });
  it('accepts an HTML update atomically and writes exact HTML without preview annotations', async () => {
    const { call, files, writes } = await setup(); const original = '<!doctype html><main><h1 id="title">Old</h1><p>Original</p></main>'; files.set('/docs/atomic.html', original);
    let s = await call('open', { path: '/docs/atomic.html', hostId: 'host-test' });
    const proposed = original.replace('>Old<', '>New<').replace('Original', 'Proposed');
    s = await call('propose', { id: s.id, revision: s.revision, content: proposed }); expect(writes).toHaveLength(0);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' }); expect(files.get(s.path)).toBe(proposed); expect(s.changes).toHaveLength(0); expect(writes).toHaveLength(1);
  });
  it('reanchors stale HTML drafts by identity when identical buttons swap source positions', async () => {
    const { call, files } = await setup(); const original = '<main><button id="aa">Learn more</button><button id="bb">Learn more</button></main>';
    files.set('/docs/buttons.html', original); let s = await call('open', { path: '/docs/buttons.html', hostId: 'host-test' });
    const anchor = makeHtmlAnchor(original, parseHtml(original).targets.find(t => t.element.attributes.id === 'aa')!.key);
    s = await call('propose', { id: s.id, revision: s.revision, content: '<main><button id="bb">Learn more</button><button id="aa">Learn more</button></main>' });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'The first original button', anchor });
    expect(s.comments[0]!.anchor?.element?.attributes.id).toBe('aa'); expect(s.comments[0]!.anchor!.start).toBeGreaterThan(anchor.start);
  });
  it('reanchors an in-progress comment after an unrelated revision and accepts empty-area comments', async () => {
    const { call, open } = await setup(); let s = await open(); const start = s.content.indexOf('cats');
    const anchor = { start, end: start + 4, quote: 'cats', prefix: s.content.slice(0, start), suffix: s.content.slice(start + 4), orphaned: false };
    s = await call('propose', { id: s.id, revision: s.revision, content: 'Introduction.\n\n' + s.content });
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Draft kept during revision', anchor }); expect(s.content.slice(s.comments[0]!.anchor!.start, s.comments[0]!.anchor!.end)).toBe('cats');
    const at = s.content.length;
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Discuss the empty end', anchor: { start: at, end: at, quote: 'Empty document area', prefix: '', suffix: '', orphaned: false, element: { format: 'markdown', tag: 'p', selector: 'end', attributes: {}, text: '', html: '', ancestors: [] } } }); expect(s.comments).toHaveLength(2);
  });
  it('reconciles external text edited inside a pending deletion without corrupting the next write', async () => {
    const { call, files } = await setup(); const original = 'Keep one. Remove two words. End.\n'; files.set('/docs/deletion.md', original);
    let s = await call('open', { path: '/docs/deletion.md', hostId: 'host-test' });
    s = await call('propose', { id: s.id, revision: s.revision, content: 'Keep one. End.\n' });
    const external = 'Keep one. Remove 2 words. End.\n'; files.set(s.path, external);
    s = await call('get', { id: s.id }); expect(s.content).toBe(external); expect(committedContent(s)).toBe(external); expect(s.changes).toEqual([]);
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content + 'Extra.', trackChanges: false });
    expect(files.get(s.path)).toBe(external + 'Extra.');
  });
  it('upgrades earlier unsaved text into reviewable work without writing its file', async () => {
    const { call, open, bb, files, writes } = await setup(); const original = await open();
    bb.storage.database().prepare('UPDATE reviews SET data=? WHERE id=?').run(JSON.stringify({ ...original, sourcePolicy: undefined, content: original.content.replace('like cats', 'love cats'), changes: [], dirty: true }), original.id);
    let s = await call('get', { id: original.id }); expect(files.get(s.path)).toBe(original.content); expect(writes).toHaveLength(0); expect(s.changes).toHaveLength(1); expect(s.notice).toContain('Earlier unsaved'); expect(committedContent(s)).toBe(s.diskContent);
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' }); expect(files.get(s.path)).toContain('love cats');
  });
  it('requires the CLI source quote and explicitly guards withdrawal of personal suggestions', async () => {
    const { call, open, files, harness } = await setup(); let s = await open(); const original = s.content;
    s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: s.content.replace('cats', 'dogs') });
    await expect(call('propose', { id: s.id, revision: s.revision, content: original.replace('tea', 'coffee') })).rejects.toThrow(/withdraws/);
    const start = s.content.indexOf('dogs');
    const bad = await harness.behavior.runCli(['comment', s.id, '--start', String(start), '--end', String(start + 4), '--body', 'Wrong file offsets', '--revision', String(s.revision), '--json']); expect(bad.exitCode).not.toBe(0);
    const wrong = await harness.behavior.runCli(['comment', s.id, '--start', String(start), '--end', String(start + 4), '--quote', 'cats', '--body', 'Wrong quote', '--revision', String(s.revision), '--json']); expect(wrong.exitCode).not.toBe(0);
    const good = await harness.behavior.runCli(['comment', s.id, '--start', String(start), '--end', String(start + 4), '--quote', 'dogs', '--body', 'Correct review offsets', '--revision', String(s.revision), '--json']); expect(good.exitCode).toBe(0);
    s = await call('get', { id: s.id }); s = await call('propose', { id: s.id, revision: s.revision, content: original.replace('tea', 'coffee'), withdrawUserSuggestions: true });
    expect(s.content).toContain('cats'); expect(files.get(s.path)).toBe(original);
  });
  it('keeps committed content equal to the file across seeded mixed revision sequences', async () => {
    const { call, open, files } = await setup(); let s = await open(), seed = 90210;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const mutate = (text: string) => { const at = rnd(text.length + 1), end = Math.min(text.length, at + rnd(5)); return text.slice(0, at) + ['X', '**', ' ', '\n', 'one'][rnd(5)] + text.slice(end); };
    for (let i = 0; i < 300; i++) {
      const op = rnd(6), before = files.get(s.path);
      if (op === 0) s = await call('propose', { id: s.id, revision: s.revision, content: mutate(s.content), withdrawUserSuggestions: true });
      else if (op === 1 || op === 2) s = await call('edit', { id: s.id, revision: s.revision, baseContent: s.content, content: mutate(s.content), trackChanges: op === 1 });
      else if (op === 3 && s.changes.length) s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[rnd(s.changes.length)]!.id, decision: 'accepted' });
      else if (op === 4 && s.changes.length) s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[rnd(s.changes.length)]!.id, decision: 'rejected' });
      else if (op === 5) { files.set(s.path, mutate(files.get(s.path)!)); s = await call('get', { id: s.id }); }
      expect(committedContent(s)).toBe(files.get(s.path));
      if (op === 0 || op === 1 || op === 4) expect(files.get(s.path)).toBe(before);
    }
  });
  it('throttles full file inventories from list refreshes but forces explicit activation', async () => {
    const { call, open, harness } = await setup(); await open();
    const read = vi.fn(async () => ({ content: '# Test\n\nI like cats.\n\nYou like tea.\n', sha256: hash('# Test\n\nI like cats.\n\nYou like tea.\n'), sizeBytes: 40, contentEncoding: 'utf8' }));
    harness.sdk.stub('files.read', read);
    await call('list', null); const first = read.mock.calls.length; expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await call('list', null); expect(read.mock.calls.length).toBe(first);
    await call('activate', null); expect(read.mock.calls.length).toBeGreaterThan(first);
  });
  it('prunes missing files but preserves reviews on offline hosts', async () => {
    const { call, open, files, harness } = await setup(); const s = await open();
    harness.sdk.stub('files.read', () => { throw new Error('Host offline'); });
    await call('activate', null); const list = await harness.behavior.callRpc('list', null) as unknown[]; expect(list).toHaveLength(1);
    harness.sdk.stub('files.read', () => { throw Object.assign(new Error('File not found'), { code: 'ENOENT' }); }); files.delete(s.path);
    await call('activate', null); expect(await harness.behavior.callRpc('list', null)).toEqual([]);
  });
  it('prunes finished reviews and old archived changes after 14 days, keeping unfinished reviews', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const { call, open, propose, harness, bb } = await setup(); let s = await propose(await open());
    s = await call('decide', { id: s.id, revision: s.revision, changeId: s.changes[0]!.id, decision: 'accepted' });
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z')); await call('activate', null);
    expect((await call('get', { id: s.id })).changes).toHaveLength(1); expect(await harness.behavior.callRpc('history', { id: s.id })).toEqual([]);
    for (const c of [...s.changes]) s = await call('decide', { id: s.id, revision: s.revision, changeId: c.id, decision: 'accepted' });
    s = await call('save', { id: s.id, revision: s.revision }); expect(s.completedAt).toBeTruthy();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z')); const service = harness.behavior.runService('review-cleanup'); await service.done;
    expect(bb.storage.database().prepare('SELECT id FROM reviews').all()).toEqual([]);
  });
  it('keeps comment replies open and prunes resolved comments after their resolution date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const { call, open, propose } = await setup(); let s = await propose(await open());
    s = await call('comment', { id: s.id, revision: s.revision, body: 'Shorten it', anchor: null }); const commentId = s.comments[0]!.id;
    s = await call('reply', { id: s.id, revision: s.revision, commentId, body: 'Done' }); expect(s.comments[0]!.status).toBe('addressed');
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z')); s = await call('commentStatus', { id: s.id, revision: s.revision, commentId, status: 'resolved' });
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z')); s = await call('get', { id: s.id }); expect(s.comments).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z')); s = await call('get', { id: s.id }); expect(s.comments).toHaveLength(0);
  });
  it('migrates stored v1 decisions and persists v2 reviews through reload', async () => {
    const { call, open, harness, bb } = await setup(); const s = await open(), base = s.content;
    const changes = computeChanges(base, base.replace('like cats', 'love cats').replace('tea', 'coffee')); changes[0]!.decision = 'accepted';
    bb.storage.database().prepare('UPDATE reviews SET data=? WHERE id=?').run(JSON.stringify({ ...s, formatVersion: undefined, base, baseSha: hash(base), proposal: 'unused', changes, savedContent: null, savedSha: null, round: 1 }), s.id);
    const migrated = await call('get', { id: s.id }); expect(migrated.formatVersion).toBe(2); expect(migrated.changes).toHaveLength(1); expect(migrated.content).toContain('love cats');
    const replacement = await harness.lifecycle.reload(plugin); cleanups.push(() => replacement.harness.lifecycle.dispose());
    expect((await replacement.harness.behavior.callRpc('get', { id: s.id }) as Session).content).toBe(migrated.content);
  });
  it('submits CLI revisions to the existing document without writing the disk file', async () => {
    const { open, harness, writes } = await setup(); const s = await open();
    const result = await harness.behavior.runCli(['propose', s.id, '--draft', '/docs/draft.md', '--revision', String(s.revision), '--json']);
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout!).directive).toBe(`::document-review{id="${s.id}"}`); expect(writes).toHaveLength(0);
  });
  it('routes workspace, host and thread-storage openers to owning hosts', async () => {
    const { call, harness } = await setup(); harness.sdk.stub('threads.get', () => makeThreadResponse({ environmentId: 'env1' })); harness.sdk.stub('environments.get', () => ({ hostId: 'remote', path: '/docs' })); harness.sdk.stub('threads.storageLocation', () => ({ hostId: 'storage-host', storageRootPath: '/docs' }));
    const source = { threadId: 't1', environmentId: 'env1', projectId: null };
    const a = await call('open', { path: 'test.md', source: { ...source, kind: 'workspace' } }); expect(a.hostId).toBe('remote');
    const b = await call('open', { path: '/docs/test.md', source: { ...source, kind: 'host' } }); expect(b.hostId).toBe('remote');
    const c = await call('open', { path: 'test.md', source: { ...source, kind: 'thread-storage' } }); expect(c.hostId).toBe('storage-host');
    await expect(call('open', { path: '../test.md', source: { ...source, kind: 'workspace' } })).rejects.toThrow(/outside/);
  });
  it('imports only public SDK and declared libraries', async () => {
    const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^parse5$/,  /^(react|react-dom|entities|@testing-library\/react|diff|unified|remark-parse|remark-gfm|remark-frontmatter|remark-stringify|remark-rehype|hast-util-to-html|hast)$/, /^@tiptap\//] }); expect(result.violations).toEqual([]); expect(result.privateDependencies).toEqual([]);
  });
});
it('confines paths on POSIX and Windows', () => { expect(confined('/docs', 'a.md')).toBe('/docs/a.md'); expect(() => confined('/docs', '../secret.md')).toThrow(); expect(confined('C:\\docs', 'a.md')).toBe('C:\\docs\\a.md'); expect(() => confined('C:\\docs', 'D:\\secret.md')).toThrow(); });
