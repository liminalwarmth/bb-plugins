import type { Anchor } from './model';
export function targetLabel(anchor: Anchor, includeSelection = true): string {
  const ref = anchor.element;
  if (includeSelection && ref?.selectedText) return `Selected text “${ref.selectedText.slice(0, 65)}${ref.selectedText.length > 65 ? '…' : ''}”`;
  if (!ref) return anchor.quote ? `Selected text “${anchor.quote.slice(0, 65)}”` : 'Whole document';
  const names: Record<string, string> = { p: 'Paragraph', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', ul: 'List', ol: 'List', table: 'Table', li: 'List item', td: 'Table cell', th: 'Table heading', img: 'Image', svg: 'Icon', canvas: 'Canvas', video: 'Video', button: 'Button', a: 'Link', input: 'Input', select: 'Select', textarea: 'Text field', section: 'Section', article: 'Article', header: 'Header', footer: 'Footer', nav: 'Navigation', main: 'Main content', blockquote: 'Quote', pre: 'Code block', hr: 'Divider' };
  if (ref.tag === 'body') return 'Page background';
  const name = ref.attributes['aria-label'] || ref.attributes.alt || ref.attributes.title || (['section', 'div', 'article'].includes(ref.tag) ? ref.attributes.id?.replaceAll('-', ' ') : '') || ref.text;
  return `${names[ref.attributes.role] ?? names[ref.tag] ?? 'Area'}${name ? ` “${name.slice(0, 65)}${name.length > 65 ? '…' : ''}”` : ''}`;
}
