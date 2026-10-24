import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { RawMarkdown, MarkdownImage } from './markdown-editor';

const Alignment = Extension.create({ name: 'markdownTableAlignment', addGlobalAttributes: () => [{ types: ['tableCell', 'tableHeader'], attributes: { markdownAlign: { default: null, renderHTML: a => a.markdownAlign ? { style: `text-align:${a.markdownAlign}` } : {} } } }] });
export function editorExtensions() {
  return [StarterKit.configure({ trailingNode: false, underline: false, link: { openOnClick: false, autolink: false } }), TableKit.configure({ table: { resizable: false } }), TaskList, TaskItem.configure({ nested: true }), Alignment, RawMarkdown, MarkdownImage];
}
