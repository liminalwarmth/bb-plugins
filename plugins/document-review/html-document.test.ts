import { describe, expect, it } from 'vitest';
import { parseHtml, makeHtmlAnchor, reanchorHtml, htmlPreview, rewriteCss } from './html-document';
import { sessionFixture } from './fixtures';
import { proposeDocument, decideChange } from './review-state';

const html = '<!doctype html><html><head><style>body{background:#eef}</style></head><body><section id="hero"><h1>A clear plan</h1><button id="start"><span>Get started</span></button><img src="images/plan.png" alt="Plan diagram"></section></body></html>';
const target = (source: string, tag: string) => parseHtml(source).targets.find(t => t.element.tag === tag)!;
describe('durable HTML element conversations', () => {
  it('does not mistake prose with an equals sign for an inline script', () => {
    expect(htmlPreview('<p>one = two</p>', 'review').scriptsDisabled).toBe(false);
    expect(htmlPreview('<p onclick="alert(1)">Text</p>', 'review').scriptsDisabled).toBe(true);
  });
  it('captures text, structural identity, original HTML, source offsets, ancestors, and a click point', () => {
    const t = target(html, 'button'), a = makeHtmlAnchor(html, t.key, { x: .3, y: .7 });
    expect(html.slice(a.start, a.end)).toBe('<button id="start"><span>Get started</span></button>');
    expect(a).toMatchObject({ quote: 'Get started', element: { format: 'html', tag: 'button', attributes: { id: 'start' }, point: { x: .3, y: .7 }, text: 'Get started' } });
    expect(a.element!.ancestors).toContain('section#hero'); expect(a.element!.selector).toContain('button:nth-of-type(1)');
  });
  it('follows an element through text rewrites and moves using its stable identity', () => {
    const a = makeHtmlAnchor(html, target(html, 'button').key), next = html.replace('<h1>A clear plan</h1>', '').replace('Get started', 'Begin here');
    const updated = reanchorHtml(a, next); expect(updated.orphaned).toBe(false); expect(updated.quote).toBe('Get started'); expect(next.slice(updated.start, updated.end)).toContain('Begin here');
  });
  it('retains a thread across a tracked element rewrite and rejection, including elements without IDs', () => {
    const source = '<main><h2>Original heading</h2><p>Other text</p></main>', s = sessionFixture(source); s.path = '/docs/plan.html';
    s.comments.push({ id: 'n', body: 'Make this direct', anchor: makeHtmlAnchor(source, target(source, 'h2').key), status: 'open', replies: [], createdAt: '' });
    proposeDocument(s, source.replace('Original heading', 'Clear heading'));
    expect(s.comments[0]!.anchor?.orphaned).toBe(false); expect(s.comments[0]!.anchor?.element?.text).toBe('Clear heading');
    while(s.changes.length) decideChange(s, s.changes[0]!.id, 'rejected');
    expect(s.content).toBe(source); expect(s.comments[0]!.anchor?.orphaned).toBe(false); expect(s.comments[0]!.replies.at(-1)?.kind).toBe('rejected');
  });
  it('replaces a pending atomic HTML proposal against its original source without stacking changes', () => {
    const source = '<main><h1>Original</h1><p>First paragraph</p></main>', s = sessionFixture(source); s.path = '/docs/plan.html';
    proposeDocument(s, source.replace('Original', 'Proposed').replace('<p>', '<p class="note">')); const id = s.changes[0]!.id;
    expect(s.changes).toHaveLength(1);
    proposeDocument(s, s.content.replace('Proposed', 'Better').replace('First', 'Second')); expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(id);
    decideChange(s, id, 'rejected'); expect(s.content).toBe(source);
  });
  it('does not move a removed or ambiguous reference onto a different element at the same index', () => {
    const a = makeHtmlAnchor(html, target(html, 'button').key);
    expect(reanchorHtml(a, html.replace('<button id="start"><span>Get started</span></button>', '<button>Something unrelated</button>')).orphaned).toBe(true);
    const source = '<div><button>Same</button><button>Same</button></div>';
    expect(reanchorHtml(makeHtmlAnchor(source, target(source, 'button').key), source).orphaned).toBe(true);
    expect(reanchorHtml(makeHtmlAnchor(source, target(source, 'button').key), '<div><button>Same</button></div>').orphaned).toBe(true);
  });
  it('supports images, SVG/design regions and an implicit page background in fragments', () => {
    expect(makeHtmlAnchor(html, target(html, 'img').key).quote).toBe('Plan diagram');
    const fragment = '<div class="swatch" style="height:80px;background:blue"></div>';
    const a = makeHtmlAnchor(fragment, target(fragment, 'div').key, { x: .5, y: .5 });
    expect(reanchorHtml(a, fragment.replace('blue', 'green')).orphaned).toBe(false);
    expect(makeHtmlAnchor(fragment, target(fragment, 'body').key).quote).toBe('Page background');
  });
  it('renders a static isolated preview with source mapping and local resources without altering source', () => {
    const source = html.replace('</head>', '<script>window.top.pwned=true</script><meta http-equiv="refresh" content="0;url=/bad"><link rel="stylesheet" href="./site.css"></head>').replace('<body>', '<body onload="alert(1)"><iframe src="/bad"></iframe>');
    const view = htmlPreview(source, 'review-test');
    expect(view.scriptsDisabled).toBe(true); expect(view.html).not.toContain('<script'); expect(view.html).not.toContain('onload='); expect(view.html).not.toContain('<iframe'); expect(view.html).not.toContain('http-equiv="refresh"');
    expect(view.html).toContain("script-src 'none'"); expect(view.html).toContain('data-dr-node="button_'); expect(view.html).toContain('/http/asset?id=review-test');
    expect(source).toContain('<script>window.top.pwned=true</script>'); expect(source).not.toContain('data-dr-node');
    expect(rewriteCss('div{background:url(../image.png)}', 'r', 'styles/')).toContain('path=styles%2F..%2Fimage.png');
  });
});
