import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { editorExtensions } from './editor-extensions';
import { parseMarkdown, serializeMarkdown } from './markdown-editor';
const schema = getSchema(editorExtensions());
const root = new URL('./test-fixtures/markdown-roundtrip/', import.meta.url);
const fixtures = readdirSync(root).map(name => ({ name, source: readFileSync(new URL(name, root), 'utf8') }));
function replace(doc: PMNode, from: string, to: string) {
  const json = doc.toJSON(); let found = false;
  const visit = (node: any) => { if (node.text?.includes(from)) { node.text = node.text.replace(from, to); found = true; } node.content?.forEach(visit); }; visit(json);
  expect(found).toBe(true); return schema.nodeFromJSON(json);
}
describe('lossless rich Markdown source fixtures', () => {
  it.each(fixtures)('loads and saves $name byte-identically with no edits', ({ source }) => {
    const parsed = parseMarkdown(source, schema);
    expect(Buffer.from(serializeMarkdown(parsed.doc, parsed))).toEqual(Buffer.from(source));
  });
  it.each(fixtures)('edits a nearby sentence without changing other bytes in $name', ({ source }) => {
    const parsed = parseMarkdown(source, schema), changed = replace(parsed.doc, 'Edit this sentence.', 'Edit this paragraph.');
    expect(serializeMarkdown(changed, parsed)).toBe(source.replace('Edit this sentence.', 'Edit this paragraph.'));
  });
  it('retains relative, anchor, and reference targets while editing link labels', () => {
    const source = fixtures.find(f => f.name === 'relative-links.md')!.source;
    let parsed = parseMarkdown(source, schema), output = serializeMarkdown(replace(parsed.doc, 'the plugin contract', 'the revised contract'), parsed);
    expect(output).toBe(source.replace('the plugin contract', 'the revised contract'));
    parsed = parseMarkdown(output, schema); output = serializeMarkdown(replace(parsed.doc, 'a reference', 'the reference'), parsed);
    expect(output).toBe(source.replace('the plugin contract', 'the revised contract').replace('a reference', 'the reference'));
    const hrefs: string[] = []; parsed.doc.descendants(node => node.marks.forEach(mark => { if (mark.type.name === 'link') hrefs.push(mark.attrs.href); }));
    expect(hrefs).toEqual(expect.arrayContaining(['plugins/CONTRACT.md', 'README.md', 'CONTRIBUTING.md#code-comments', '#section', '../README.md']));
  });
  it('stores a newly typed trailing space as a space and preserves old escapes/entities', () => {
    const source = 'Please rewrite it. And preserve \\*literal\\* &amp; &#x20;.\n';
    const parsed = parseMarkdown(source, schema), changed = replace(parsed.doc, 'it.', 'it. ');
    expect(serializeMarkdown(changed, parsed)).toBe(source.replace('it.', 'it. '));
    const tail = parseMarkdown('Please rewrite it.\n', schema);
    expect(serializeMarkdown(replace(tail.doc, 'it.', 'it. '), tail)).toBe('Please rewrite it. \n');
  });
  it.each(fixtures.filter(f => f.name.includes('table') || f.name === 'crlf.md'))('edits a cell without normalizing table syntax in $name', ({ source }) => {
    const parsed = parseMarkdown(source, schema), changed = replace(parsed.doc, 'tiny', 'substantially longer');
    expect(serializeMarkdown(changed, parsed)).toBe(source.replace('tiny', 'substantially longer'));
  });
  it('keeps template lines outside the rendered table and editable as literal source', () => {
    const source = fixtures.find(f => f.name === 'template-after-table.md')!.source, parsed = parseMarkdown(source, schema);
    const table = Array.from({ length: parsed.doc.childCount }, (_, i) => parsed.doc.child(i)).find(n => n.type.name === 'table')!;
    expect(table.childCount).toBe(2); expect(table.textContent).not.toContain('houseRules');
    expect(serializeMarkdown(replace(parsed.doc, '{{houseRules}}', '{{customRules}}'), parsed)).toBe(source.replace('{{houseRules}}', '{{customRules}}'));
  });
  it('preserves neighboring nested markup, reference links, escapes and whitespace during formatting', () => {
    const source = 'Edit here, then _**nested**_ and [reference][r] and \\*literal\\*. \n\n[r]: README.md\n';
    const parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON();
    json.content[0].content[0] = { type: 'text', text: 'Edit here', marks: [{ type: 'bold' }] };
    json.content[0].content.splice(1, 0, { type: 'text', text: ', then ' });
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.replace('Edit here', '**Edit here**'));
  });
});

describe('source-preserving structural edits', () => {
  it('edits an empty Markdown file and retains its existing line ending', () => {
    for (const source of ['', '\n', '\r\n']) {
      const parsed = parseMarkdown(source, schema), next = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text ' }] }] });
      expect(serializeMarkdown(next, parsed)).toBe('Text ' + source);
    }
  });
  it('keeps literal spaces in a new paragraph and source syntax in its neighbors', () => {
    const source = 'Old [README](README.md) and &amp; entity.\n', parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON();
    json.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Please rewrite it. ' }] });
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.slice(0, -1) + '\n\nPlease rewrite it. \n');
  });
  it('edits a tilde-fenced code body without changing its fence or outside whitespace', () => {
    const source = '~~~~js\nold\n~~~~\n', parsed = parseMarkdown(source, schema);
    expect(serializeMarkdown(replace(parsed.doc, 'old', 'new'), parsed)).toBe(source.replace('old', 'new'));
    const empty = parseMarkdown('~~~~js\n~~~~\n', schema), json = empty.doc.toJSON(); json.content[0].content = [{ type: 'text', text: 'new' }];
    expect(serializeMarkdown(schema.nodeFromJSON(json), empty)).toBe('~~~~js\nnew\n~~~~\n');
  });
  it('deletes rows without padding cells, changing the delimiter, or absorbing a template', () => {
    const source = '|A|Reference|\n|-|:--|\n|one|[README](README.md)|\n|two|&amp;|\n{{#houseRules}}\n';
    const parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON(); json.content[0].content.splice(1, 1);
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.replace('|one|[README](README.md)|\n', ''));
  });
  it('deletes a column while preserving each surviving cell’s original padding', () => {
    const source = '| A |Reference|\n| - |:--|\n|one  |[README](README.md)|\n| two|&amp;|\n{{#houseRules}}\n';
    const parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON(); json.content[0].content.forEach((r: any) => r.content.splice(1, 1));
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe('| A |\n| - |\n|one  |\n| two|\n{{#houseRules}}\n');
  });
  it('keeps star bullets, reference forms, escapes and compact list spacing when removing an item', () => {
    const source = '* One [link][r]\n* Two &amp; \\*literal\\*\n* Three [README](README.md)\n\n[r]: README.md\n';
    const parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON(); json.content[0].content.splice(1, 1);
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.replace('* Two &amp; \\*literal\\*\n', ''));
  });
});

describe('incremental literal whitespace', () => {
  it.each(['Text\n', 'Text \n', '|A|B|\n|-|-|\n|Text|value|\n', '| A | B |\n| - | - |\n| Text | value |\n'])('keeps a typed space in place when typing resumes: %s', source => {
    let parsed = parseMarkdown(source, schema);
    const space = replace(parsed.doc, 'Text', 'Text '), saved = serializeMarkdown(space, parsed);
    expect(saved).toBe(source.replace('Text', 'Text '));
    parsed = parseMarkdown(saved, schema, false, space);
    expect(parsed.doc.eq(space)).toBe(true);
    const word = replace(space, 'Text ', 'Text word');
    expect(serializeMarkdown(word, parsed)).toBe(source.replace('Text', 'Text word'));
  });
  it('keeps newly typed leading spaces and does not duplicate them on the next edit', () => {
    const source = 'Text\n'; let parsed = parseMarkdown(source, schema);
    const space = replace(parsed.doc, 'Text', ' Text'), saved = serializeMarkdown(space, parsed);
    expect(saved).toBe(' Text\n'); parsed = parseMarkdown(saved, schema, false, space); expect(parsed.doc.eq(space)).toBe(true);
    expect(serializeMarkdown(replace(space, ' Text', ' PrefixText'), parsed)).toBe(' PrefixText\n');
  });
});

describe('empty source locations', () => {
  it.each([0, 1])('types into empty table cell %i without putting content outside the table', column => {
    const source = '|A|B|\n|-|-|\n| | |\n', parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON();
    json.content[0].content[1].content[column].content[0].content = [{ type: 'text', text: 'word' }];
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.replace('| | |', column === 0 ? '| word| |' : '| | word|'));
  });
  it('keeps a space followed later by text inside an empty cell', () => {
    const source = '|A|B|\n|-|-|\n| | |\n'; let parsed = parseMarkdown(source, schema), json = parsed.doc.toJSON();
    json.content[0].content[1].content[1].content[0].content = [{ type: 'text', text: ' ' }];
    const space = schema.nodeFromJSON(json), saved = serializeMarkdown(space, parsed); expect(saved).toBe(source.replace('| | |', '| |  |'));
    parsed = parseMarkdown(saved, schema, false, space); expect(parsed.doc.eq(space)).toBe(true);
    json = space.toJSON(); json.content[0].content[1].content[1].content[0].content[0].text = ' word';
    expect(serializeMarkdown(schema.nodeFromJSON(json), parsed)).toBe(source.replace('| | |', '| |  word|'));
  });
  it('keeps a space followed by text in an initially empty document', () => {
    const source = ''; let parsed = parseMarkdown(source, schema);
    const space = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] }), saved = serializeMarkdown(space, parsed);
    expect(saved).toBe(' '); parsed = parseMarkdown(saved, schema, false, space); expect(parsed.doc.eq(space)).toBe(true);
    expect(serializeMarkdown(replace(space, ' ', ' word'), parsed)).toBe(' word');
  });
});
