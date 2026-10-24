import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from './editor-extensions';
import { parseMarkdown, serializeMarkdown, sourceToPosition, positionToSource } from './markdown-editor';
const schema = getSchema(editorExtensions());
const examples = [
  '# Heading\r\n\r\nA **bold** paragraph and _italic_.\r\n',
  '---\ntitle: My doc\nauthor: You\n---\n\n# Title\n\nA [link][id].\n\n[id]: https://getbb.app "BB"\n',
  '| A | B |\n| :--- | ---: |\n| hello | world |\n\n- [x] Done\n- [ ] Next\n',
  '> Quote\n>\n> - list\n> - another\n\n```ts\nconst a = 1;\n```\n\n![alt](image.png)\n',
  '<!-- keep this comment -->\n\n<div>Raw HTML stays literal and editable</div>\n\nFootnote[^a].\n\n[^a]: Keep me.\n',
];
describe('rich Markdown adapter', () => {
  it.each(examples)('preserves the exact original source until a block is edited', source => {
    const document = parseMarkdown(source, schema); expect(serializeMarkdown(document.doc, document)).toBe(source);
  });
  it('serializes text/formatting edits while preserving unrelated frontmatter, code and line endings', () => {
    const source = '---\r\ntitle: Keep\r\n---\r\n\r\nOld paragraph.\r\n\r\n```js\r\nconst x=1\r\n```\r\n';
    const original = parseMarkdown(source, schema), json = original.doc.toJSON();
    json.content[1].content = [{ type: 'text', text: 'New', marks: [{ type: 'bold' }] }, { type: 'text', text: ' paragraph.' }];
    const result = serializeMarkdown(schema.nodeFromJSON(json), original);
    expect(result).toBe(source.replace('Old paragraph.', '**New** paragraph.'));
  });
  it('maps selection positions across bold text and entities to exact Markdown ranges', () => {
    const source = 'Hello **bold** &amp; world.\n', parsed = parseMarkdown(source, schema);
    const start = source.indexOf('bold'), end = start + 4;
    expect(positionToSource(parsed, sourceToPosition(parsed, start, 1), 1)).toBe(start);
    expect(positionToSource(parsed, sourceToPosition(parsed, end, -1), -1)).toBe(end);
    const entity = source.indexOf('&amp;'); expect(positionToSource(parsed, sourceToPosition(parsed, entity, 1), 1)).toBe(entity);
  });
  it('serializes nested formatting and links without duplicating delimiters', () => {
    const original = parseMarkdown('hello world\n', schema), json = original.doc.toJSON();
    json.content[0].content = [{ type: 'text', text: 'hello ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'world', marks: [{ type: 'bold' }, { type: 'italic' }] }];
    const output = serializeMarkdown(schema.nodeFromJSON(json), original); expect(parseMarkdown(output, schema).doc.toJSON()).toEqual(schema.nodeFromJSON(json).toJSON());
  });
  it('keeps plain text literal rather than applying Markdown formatting', () => { const parsed = parseMarkdown('# Literal\n**stars**\n', schema, true); expect(parsed.doc.child(0).type.name).toBe('rawMarkdown'); expect(serializeMarkdown(parsed.doc, parsed, true)).toBe('# Literal\n**stars**\n'); });
});
