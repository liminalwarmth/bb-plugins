import { describe, it, expect } from 'vitest';
import { computeChanges, resultText, makeAnchor, reanchor } from './model';
import { renderMarkdown, reviewDocument, commentMarks } from './render';

describe('lossless review decisions', () => {
  const cases = [
    ['', '# Hello\n'], ['all gone\n', ''], ['same', 'same'],
    ['# Old\r\n\r\n- **keep** café 😀\r\n', '# New\r\n\r\n- **keep** tea 🐈\r\n'],
    ['[hello](https://old.test)\n\n| x | y |\n|---|---|\n|1|2|\n', '[hello](https://new.test)\n\n| x | z |\n|---|---|\n|1|3|\n'],
    ['a  b\n\tend', 'a b\n\nend\n'], ['```js\nconst a = 1;\n```\n', '```ts\nconst a = 2;\n```\n'],
  ];
  it.each(cases)('preserves exact source: %j → %j', (base, proposal) => {
    const changes = computeChanges(base, proposal);
    expect(resultText(base, changes)).toBe(base);
    expect(resultText(base, changes.map(c => ({ ...c, decision: 'accepted' })))).toBe(proposal);
    expect(resultText(base, changes.map(c => ({ ...c, decision: 'rejected' })))).toBe(base);
    for (const c of changes) expect(base.slice(c.start, c.end)).toBe(c.before);
  });
  it('composes independent mixed decisions without replacing unrelated text', () => {
    const base = 'I like cats.\n\nYou like tea.\n', proposal = 'I love cats.\n\nYou like coffee.\n';
    const changes = computeChanges(base, proposal); changes[0]!.decision = 'accepted'; changes[1]!.decision = 'rejected';
    expect(resultText(base, changes)).toBe('I love cats.\n\nYou like tea.\n');
  });
  it('groups adjacent word substitutions into a readable phrase', () => {
    const changes = computeChanges('We should make it very easy.', 'This workflow helps you improve it.');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).toBe('We should make it very easy');
    expect(changes[0]!.after).toBe('This workflow helps you improve it');
  });
  it('round trips varied whitespace and Unicode documents', () => {
    let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2**32;
    const tokens = ['# ', 'hello', '😀', '\r\n', '\n\n', '**', '[a](b)', '\t', ' ', 'café', '日本語'];
    for (let n = 0; n < 150; n++) {
      const source = Array.from({ length: 60 }, () => tokens[Math.floor(rand() * tokens.length)]).join('');
      const cut = Math.floor(rand() * source.length), proposal = source.slice(0, cut) + 'new 🐈\n' + source.slice(cut + Math.floor(rand() * 20));
      expect(resultText(source, computeChanges(source, proposal), 'after')).toBe(proposal);
    }
  });
});
describe('anchored comments', () => {
  it('moves a quote with its text', () => { const a = makeAnchor('abc target xyz', 4, 10); expect(reanchor(a, 'prefix abc target xyz')?.start).toBe(11); });
  it('marks deleted or ambiguous text as orphaned', () => {
    const a = makeAnchor('target', 0, 6);
    expect(reanchor(a, 'gone')?.orphaned).toBe(true); expect(reanchor(a, 'target target')?.orphaned).toBe(true);
  });
  it('uses context to distinguish repeated text', () => {
    const a = makeAnchor('left target right', 5, 11);
    expect(reanchor(a, 'other target! left target right')?.start).toBe(19);
  });
});
describe('rich Markdown rendering', () => {
  it('renders inline old/new text, headings, lists, tables, and original offsets', () => {
    const base = '# Greeting\n\nHello old world.\n\n- A **bold** item\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const doc = reviewDocument(base, computeChanges(base, base.replace('old', 'new'))), html = renderMarkdown(doc.text, doc.marks);
    expect(html).toContain('<h1'); expect(html).toContain('<table'); expect(html).toContain('<strong');
    expect(html).toMatch(/<del[^>]*>old<\/del>/); expect(html).toMatch(/<ins[^>]*>new<\/ins>/);
    expect(html).toContain('data-source-start=');
  });
  it('never runs raw HTML or active links and does not fetch remote images', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![private](https://tracking.test/x)\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script'); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('<img'); expect(html).not.toContain('onerror=');
    expect(html).toContain('[Image: private]');
  });
  it('highlights comment anchors without adding markers to the file', () => {
    const base = 'Hello world'; const anchor = makeAnchor(base, 6, 11);
    const marks = commentMarks([{ id: 'n1', body: 'rewrite', anchor, status: 'open', replies: [], createdAt: '' }]);
    expect(renderMarkdown(base, marks)).toMatch(/data-comment-id="n1"[^>]*>world/);
  });
});
