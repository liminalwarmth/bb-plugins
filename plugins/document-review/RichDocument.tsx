import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UrlLink } from '@get-bb/plugin-sdk/app';
import { Extension } from '@tiptap/core';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { editorExtensions } from './editor-extensions';
import { parseMarkdown, serializeMarkdown, sourceToPosition, positionToSource, type MarkdownDocument } from './markdown-editor';
import { renderMarkdown } from './render';
import { makeAnchor, type Anchor, type Change, type Comment } from './model';
import { CommentMenu, type CommentTarget } from './CommentMenu';
import { useCallback } from 'react';

export interface RichDocumentHandle { scrollTo: (start: number, end?: number, id?: string) => void; undo: () => void; redo: () => void; selection: () => { start: number; end: number } | null; commentAnchor?: () => Anchor | null; startComment?: () => void }
type Props = { content: string; changes: Change[]; comments: Comment[]; plain: boolean; editable?: boolean; active: string; onChange: (content: string) => void; onComment: (range: { start: number; end: number }) => void; onPick: (id: string) => void; onDeselect?: () => void; draftAnchor?: Anchor | null; onElementComment?: (anchor: Anchor, choices?: Anchor[]) => void };
function FormatBar({ editor, range, onComment, top, left, maxWidth, onLinkMode, onInteraction, toolbarRef, caretLink = false, linkRequest = 0 }: { caretLink?: boolean; linkRequest?: number; onLinkMode: (open: boolean) => void; onInteraction: (active: boolean) => void; toolbarRef: React.RefObject<HTMLDivElement | null>; editor: Editor; range: { start: number; end: number }; onComment: Props['onComment']; top: number; left: number; maxWidth: number }) {
  const [link, setLink] = useState<string | null>(null), [linkError, setLinkError] = useState('');
  useEffect(() => () => onLinkMode(false), []);
  const styleSelection = useRef({ from: editor.state.selection.from, to: editor.state.selection.to });
  const holdStyleSelection = () => { styleSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to }; onInteraction(true); };
  const linkSelection = useRef({ from: editor.state.selection.from, to: editor.state.selection.to });
  const openLink = () => { onLinkMode(true); linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to }; setLinkError(''); setLink(editor.getAttributes('link').href ?? ''); };
  useEffect(() => { if (linkRequest) openLink(); }, [linkRequest]);
  const format = (label: string, action: () => void, active = false) => <button type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={e => e.preventDefault()} onClick={action}>{label === 'Bold' ? <b>B</b> : label === 'Italic' ? <i>I</i> : label === 'Strikethrough' ? <s>S</s> : label === 'Inline code' ? '< >' : label}</button>;
  return createPortal(<div ref={toolbarRef} className="dr-floating" onPointerDownCapture={() => onInteraction(true)} onMouseDownCapture={() => onInteraction(true)} onFocusCapture={() => onInteraction(true)} onClick={e => { if (!(e.target as HTMLElement).closest('select,input,form')) onInteraction(false); }} role="toolbar" aria-label="Selection formatting" style={{ top, left, maxWidth }} onMouseDown={e => { if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) e.preventDefault(); }}>
    {caretLink && link === null ? <><UrlLink href={editor.getAttributes('link').href ?? ''}>Open link</UrlLink><button type="button" onClick={openLink}>Edit link</button><button type="button" onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>Remove link</button></> : <>
    {format('Bold', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
    {format('Italic', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
    {format('Strikethrough', () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
    {format('Inline code', () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
    <span className="dr-format-separator" />
    <select onPointerDown={holdStyleSelection} onMouseDown={holdStyleSelection} onFocus={holdStyleSelection} aria-label="Paragraph style" title="Paragraph style" value={editor.isActive('heading') ? `h${editor.getAttributes('heading').level}` : 'paragraph'} onChange={e => { const style = e.target.value, chain = editor.chain().setTextSelection(styleSelection.current).focus(); if (style === 'paragraph') chain.setParagraph().run(); else chain.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 }).run(); onInteraction(false); }}><option value="paragraph">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option></select>
    {format('List', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
    {format('Link', openLink)}
    <span className="dr-format-separator" />
    {format('Comment', () => onComment(range))}</>}
    {link !== null && <form className="dr-link-form" onSubmit={e => {
      e.preventDefault(); let href = link.trim();
      if (href && !/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) && /^[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$)/.test(href)) href = `https://${href}`;
      if (href && !/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href)) { setLinkError('Enter a web address, email link, or document path.'); return; }
      const chain = editor.chain().focus().setTextSelection(linkSelection.current).extendMarkRange('link');
      if (href && linkSelection.current.from === linkSelection.current.to && !editor.isActive('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
      else if (href) chain.setLink({ href }).run(); else chain.unsetLink().run();
      setLink(null); setLinkError(''); onLinkMode(false);
    }}><input autoFocus aria-label="Link URL" placeholder="https://…" value={link} onChange={e => { setLink(e.target.value); setLinkError(''); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setLink(null); onLinkMode(false); editor.commands.focus(); } }} /><button type="submit">Apply link</button><button type="button" onClick={() => { setLink(null); onLinkMode(false); editor.commands.focus(); }}>Cancel</button>{linkError && <span role="alert">{linkError}</span>}</form>}

  </div>, document.body);
}

export const RichDocument = forwardRef<RichDocumentHandle, Props>(function RichDocument(props, ref) {
  const latest = useRef(props); latest.current = props;
  const toolbar = useRef<HTMLDivElement | null>(null), toolbarInteraction = useRef(false);
  const menuAnchor = useRef<Anchor | null>(null);
  const parsed = useRef<MarkdownDocument | null>(null), host = useRef<HTMLDivElement>(null);
  const linkEditing = useRef(false);
  const [linkRequest, setLinkRequest] = useState(0);
  const [inTable, setInTable] = useState(false);
  const [menu, setMenu] = useState<CommentTarget | null>(null);
  menuAnchor.current = menu?.anchor ?? null;
  const closeMenu = useCallback(() => setMenu(null), []);
  const [bar, setBar] = useState<{ top: number; left: number; maxWidth: number; range: { start: number; end: number }; caretLink?: boolean } | null>(null);
  const key = useMemo(() => new PluginKey('document-review-annotations'), []);
  const annotation = useMemo(() => Extension.create({ name: 'reviewAnnotations', addProseMirrorPlugins: () => [new Plugin({ key, props: {
    decorations(state) {
      const map = parsed.current; if (!map) return DecorationSet.empty;
      const decorations: Decoration[] = [];
      for (const c of latest.current.changes) {
        const from = Math.max(0, Math.min(state.doc.content.size, sourceToPosition(map, c.start, 1))), to = Math.max(from, Math.min(state.doc.content.size, sourceToPosition(map, c.end, -1)));
        const commentFocused = latest.current.comments.some(note => note.status !== 'resolved' && note.id === latest.current.active && note.anchor && !note.anchor.orphaned && note.anchor.removed && note.anchor.start === c.start);
        const active = latest.current.active === c.id ? ' dr-focused' : commentFocused ? ' dr-comment-focused' : '';
        if (to > from) decorations.push(Decoration.inline(from, to, { class: `dr-insert${active}`, 'data-review-item': c.id, 'data-change-id': c.id }));
        if (c.before) decorations.push(Decoration.widget(from, () => {
          const el = document.createElement('del'); el.contentEditable = 'false'; el.className = `dr-deletion${active}`; el.dataset.reviewItem = c.id; el.dataset.changeId = c.id; el.setAttribute('aria-label', `Removed text: ${c.before}`);
          el.innerHTML = renderMarkdown(c.before.trim()).replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '');
          if (!c.before.trim()) el.textContent = c.before;
          else { el.prepend(document.createTextNode(c.before.match(/^\s*/)?.[0] ?? '')); el.append(document.createTextNode(c.before.match(/\s*$/)?.[0] ?? '')); }
          el.addEventListener('mousedown', e => { e.preventDefault(); latest.current.onPick(c.id); }); return el;
        }, { side: -1, key: `${c.id}:${c.before}:${active}` }));
        if (!c.before && to === from) decorations.push(Decoration.widget(from, () => { const el = document.createElement('span'); el.className = 'dr-suggestion-point'; el.textContent = '↳'; el.dataset.reviewItem = c.id; el.onclick = () => latest.current.onPick(c.id); return el; }, { key: c.id }));
      }
      const decorateAnchor = (anchor: Anchor, classes: string, attrs: Record<string, string> = {}) => {
        const from = Math.max(0, Math.min(state.doc.content.size, sourceToPosition(map, anchor.start, 1))), to = Math.max(from, Math.min(state.doc.content.size, sourceToPosition(map, anchor.end, -1)));
        const index = map.blocks.findIndex(b => b.start === anchor.start && b.end === anchor.end);
        if (anchor.element?.format === 'markdown' && index >= 0 && index < state.doc.childCount) {
          let at = 0; for (let i = 0; i < index; i++) at += state.doc.child(i).nodeSize;
          decorations.push(Decoration.node(at, at + state.doc.child(index).nodeSize, { class: classes, ...attrs }));
        } else if (to > from) decorations.push(Decoration.inline(from, to, { class: classes, ...attrs }));
        else decorations.push(Decoration.widget(from, () => { const el = document.createElement('span'); el.className = classes; el.contentEditable = 'false'; el.textContent = '⌖ Comment area'; return el; }, { key: 'draft-area' }));
      };
      const draft = latest.current.draftAnchor ?? menuAnchor.current;
      if (draft && !draft.orphaned) decorateAnchor(draft, 'dr-draft-target');
      for (const c of latest.current.comments) {
        const focused = latest.current.active === c.id;
        if (c.status === 'resolved' || !c.anchor) continue;
        const from = Math.max(0, Math.min(state.doc.content.size, sourceToPosition(map, c.anchor.start, 1)));
        const to = Math.max(from, Math.min(state.doc.content.size, sourceToPosition(map, c.anchor.end, -1)));
        if (!c.anchor.orphaned && (to > from || c.anchor.element?.format === 'markdown')) decorateAnchor(c.anchor, `dr-comment-anchor${focused ? ' dr-comment-focused' : ''}`, { 'data-review-item': c.id, 'data-comment-id': c.id });
        else decorations.push(Decoration.widget(from, () => {
          const el = document.createElement('span'); el.contentEditable = 'false'; el.className = `dr-comment-marker${focused ? ' dr-comment-focused' : ''}`;
          el.dataset.reviewItem = c.id; el.dataset.commentId = c.id;
          el.textContent = c.anchor!.orphaned ? '⌖ Original passage' : c.anchor!.quote === 'Empty document area' ? '⌖ Document area' : '⌖ Removed passage';
          el.title = c.anchor!.quote; el.setAttribute('aria-label', `${el.textContent}: ${c.anchor!.quote}`);
          el.addEventListener('mousedown', e => { e.preventDefault(); latest.current.onDeselect?.(); }); return el;
        }, { side: -1, key: `comment:${c.id}:${focused}:${c.anchor.orphaned}:${c.anchor.quote}` }));
      }
      return DecorationSet.create(state.doc, decorations);
    },
  } })] }), [key]);
  const editor: Editor | null = useEditor({
    extensions: useMemo(() => [...editorExtensions(), annotation], [annotation]), immediatelyRender: false,
    editorProps: { handleKeyDown(view, event) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      let selected = view.state.selection;
      // A normal text drag across every cell is a row selection too.
      if (!selected.empty && !(selected instanceof CellSelection)) {
        const rowDepth = (pos: typeof selected.$from) => { for (let d = pos.depth; d > 0; d--) if (pos.node(d).type.name === 'tableRow') return d; return 0; };
        const a = selected.$from, b = selected.$to, da = rowDepth(a), db = rowDepth(b);
        if (da && db && a.node(da - 1) === b.node(db - 1) && selected.from <= a.start(da) + 2 && selected.to >= b.end(db) - 2) {
          const first = view.state.doc.resolve(a.start(da)), last = view.state.doc.resolve(b.end(db) - b.node(db).lastChild!.nodeSize);
          view.dispatch(view.state.tr.setSelection(CellSelection.rowSelection(first, last))); selected = view.state.selection;
        }
      }
      if (selected instanceof CellSelection && selected.isRowSelection()) {
        event.preventDefault(); return editor?.commands.deleteRow() ?? false;
      }
      return false;
    }, attributes: { class: 'dr-prose dr-editable', role: 'textbox', 'aria-label': 'Editable document', 'aria-multiline': 'true', spellcheck: 'true' } },
    onCreate({ editor }) { parsed.current = parseMarkdown(latest.current.content, editor.schema, latest.current.plain); editor.chain().setMeta('addToHistory', false).setContent(parsed.current.doc.toJSON(), { emitUpdate: false }).run(); },
    onUpdate({ editor }) {
      if (!parsed.current) return;
      const content = serializeMarkdown(editor.state.doc, parsed.current, latest.current.plain);
      parsed.current = parseMarkdown(content, editor.schema, latest.current.plain, editor.state.doc);
      latest.current.onChange(content);
    },
  });
  useEffect(() => { editor?.setEditable(props.editable !== false, false); }, [editor, props.editable]);
  useEffect(() => {
    if (!editor) return;
    const update = () => setInTable(editor.isActive('table'));
    editor.on('selectionUpdate', update); editor.on('transaction', update); update();
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);
  const selection = () => {
    if (!editor || !parsed.current || editor.state.selection.empty) return null;
    const start = positionToSource(parsed.current, editor.state.selection.from, 1), end = positionToSource(parsed.current, editor.state.selection.to, -1);
    return end > start ? { start, end } : null;
  };
  function blockTargets(pos: number, target: HTMLElement, x: number, y: number): { anchor: Anchor; choices: Anchor[] } | null {
    if (!editor || !parsed.current) return null;
    const map = parsed.current, source = map.source, doc = editor.state.doc;
    const resolved = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    let top = resolved.depth ? resolved.index(0) : Math.min(resolved.index(), doc.childCount - 1);
    top = Math.max(0, Math.min(top, doc.childCount - 1));
    const tags: Record<string, string> = { paragraph: 'p', listItem: 'li', taskItem: 'li', bulletList: 'ul', orderedList: 'ol', taskList: 'ul', table: 'table', tableCell: 'td', tableHeader: 'th', codeBlock: 'pre', rawMarkdown: 'pre', blockquote: 'blockquote', horizontalRule: 'hr' };
    let depth = resolved.depth;
    for (let d = resolved.depth; d > 1; d--) if (['listItem', 'taskItem', 'tableCell', 'tableHeader'].includes(resolved.node(d).type.name)) { depth = d; break; }
    const choices: Anchor[] = [];
    for (let d = Math.max(1, depth); d >= 1; d--) {
      const node = resolved.depth >= d ? resolved.node(d) : doc.child(top);
      if (d !== depth && d !== 1 && !['bulletList', 'orderedList', 'taskList', 'table', 'blockquote'].includes(node.type.name)) continue;
      const block = d === 1 ? map.blocks[top] : undefined;
      const start = block?.start ?? (resolved.depth >= d ? positionToSource(map, resolved.start(d), 1) : 0);
      const fullEnd = block?.end ?? (resolved.depth >= d ? positionToSource(map, resolved.end(d), -1) : source.length), end = Math.max(start, Math.min(fullEnd, start + 20_000));
      if (choices.some(a => a.start === start && a.end === end)) continue;
      const anchor: Anchor = end > start ? makeAnchor(source, start, end) : { start, end, quote: 'Empty document area', prefix: source.slice(Math.max(0, start - 80), start), suffix: source.slice(end, end + 80), orphaned: false };
      const dom = resolved.depth >= d ? editor.view.nodeDOM(resolved.before(d)) : target;
      const rect = dom?.nodeType === 1 ? (dom as HTMLElement).getBoundingClientRect() : target.getBoundingClientRect();
      const image = choices.length === 0 ? target.closest('[data-markdown-image]') : null;
      anchor.element = { format: 'markdown', tag: image ? 'img' : node.type.name === 'heading' ? `h${node.attrs.level}` : tags[node.type.name] ?? 'div', selector: d === 1 ? `block:${top}` : `node:${resolved.before(d)}`, attributes: image ? { alt: (image.textContent ?? '').replace(/^\[Image: /, '').replace(/\]$/, '').slice(0, 1000) } : {}, text: node.textContent.slice(0, 1000), html: source.slice(start, end).slice(0, 3000), ancestors: [node.type.name], point: { x: Math.max(0, Math.min(1, (x - rect.left) / Math.max(rect.width, 1))), y: Math.max(0, Math.min(1, (y - rect.top) / Math.max(rect.height, 1))) } };
      choices.push(anchor);
    }
    return choices[0] ? { anchor: choices[0], choices } : null;
  }
  useEffect(() => {
    if (!editor) return;
    if (!parsed.current || parsed.current.source !== props.content) {
      if (linkEditing.current || toolbarInteraction.current) { toolbarInteraction.current = false; linkEditing.current = false; setBar(null); setLinkRequest(0); }
      const oldMap = parsed.current, oldSelection = editor.state.selection;
      const previousStart = oldMap ? positionToSource(oldMap, oldSelection.from, 1) : 0;
      parsed.current = parseMarkdown(props.content, editor.schema, props.plain);
      const scroll = host.current?.closest('.dr-document-scroll'), top = scroll?.scrollTop;
      editor.chain().setMeta('addToHistory', false).setContent(parsed.current.doc.toJSON(), { emitUpdate: false }).run();
      const pos = Math.min(editor.state.doc.content.size, sourceToPosition(parsed.current, Math.min(previousStart, props.content.length)));
      editor.commands.setTextSelection(pos);
      if (scroll && top !== undefined) scroll.scrollTop = top;
    }
    editor.view.dispatch(editor.state.tr.setMeta(key, true));
  }, [editor, props.content, props.changes, props.comments, props.active, props.draftAnchor, menu, key]);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (linkEditing.current || toolbarInteraction.current || (document.activeElement && toolbar.current?.contains(document.activeElement))) return;
      const caretLink = editor.state.selection.empty && editor.isActive('link');
      const at = parsed.current ? positionToSource(parsed.current, editor.state.selection.from, 1) : 0;
      const range = selection() ?? (caretLink ? { start: at, end: at } : null);
      if (!editor.isFocused) { blur(); return; }
      if (!range || latest.current.plain) { setBar(null); return; }
      try {
        const from = editor.view.coordsAtPos(editor.state.selection.from), to = editor.view.coordsAtPos(editor.state.selection.to);
        const parent = host.current?.closest('.dr-document-scroll')?.getBoundingClientRect();
        const top = Math.min(from.top, to.top);
        if (parent && (top < parent.top - 20 || top > parent.bottom)) { setBar(null); return; }
        const maxWidth = Math.max(180, Math.min(520, (parent?.width ?? window.innerWidth) - 16, window.innerWidth - 16));
        const minLeft = Math.max(8, (parent?.left ?? 0) + 8), maxLeft = Math.max(minLeft, (parent?.right ?? window.innerWidth) - maxWidth - 8);
        setBar({ range, caretLink, maxWidth, top: Math.max(8, top - (maxWidth < 300 ? 122 : maxWidth < 450 ? 84 : 48)), left: Math.max(minLeft, Math.min(maxLeft, (from.left + to.right) / 2 - maxWidth / 2)) });
      } catch { setBar(null); }
    };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const blur = () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (!editor.isFocused && !linkEditing.current && !toolbarInteraction.current && !(document.activeElement && toolbar.current?.contains(document.activeElement))) setBar(null); }, 50); };
    const focus = () => { toolbarInteraction.current = false; update(); };
    const outside = (e: Event) => { const target = e.target as Node; if (!toolbar.current?.contains(target) && !host.current?.contains(target)) { toolbarInteraction.current = false; linkEditing.current = false; setBar(null); } };
    editor.on('selectionUpdate', update); editor.on('transaction', update); editor.on('focus', focus); editor.on('blur', blur);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
    const scroll = host.current?.closest('.dr-document-scroll'); scroll?.addEventListener('scroll', update); window.addEventListener('resize', update);
    return () => { clearTimeout(blurTimer); editor.off('selectionUpdate', update); editor.off('transaction', update); editor.off('focus', focus); editor.off('blur', blur); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); scroll?.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [editor]);
  useImperativeHandle(ref, () => ({
    selection,
    undo: () => { editor?.commands.undo(); }, redo: () => { editor?.commands.redo(); },
    scrollTo(start, _end, id) {
      if (!editor || !parsed.current || !host.current) return;
      const pos = sourceToPosition(parsed.current, start, 1);
      let target = id ? host.current.querySelector<HTMLElement>(`[data-review-item="${id}"]`) : null;
      if (!target) { const at = editor.view.domAtPos(Math.min(pos, editor.state.doc.content.size)); target = at.node.nodeType === 1 ? at.node as HTMLElement : at.node.parentElement; }
      const scroll = host.current.closest<HTMLElement>('.dr-document-scroll');
      if (target && scroll) scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3, behavior: 'smooth' });
    },
  }), [editor]);
  function contextComment(event: React.MouseEvent<HTMLDivElement>) {
    if (!editor || !parsed.current || !props.onElementComment) return;
    if (event.shiftKey || menu) { setMenu(null); return; }
    const target = event.target as HTMLElement;
    if (!host.current?.contains(target)) return;
    event.preventDefault(); props.onDeselect?.(); setBar(null);
    // A context menu can arrive before ProseMirror observes the final drag
    // selection. Read the visible DOM selection before moving focus to the menu.
    const native = window.getSelection(), nativeRange = native?.rangeCount ? native.getRangeAt(0) : null;
    if (nativeRange && !nativeRange.collapsed && editor.view.dom.contains(nativeRange.startContainer) && editor.view.dom.contains(nativeRange.endContainer)) {
      try {
        const from = editor.view.posAtDOM(nativeRange.startContainer, nativeRange.startOffset), to = editor.view.posAtDOM(nativeRange.endContainer, nativeRange.endOffset);
        if (from < to) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
      } catch { /* Existing editor selection remains a safe fallback. */ }
    }
    const selected = selection();
    let hit: { pos: number } | null = null;
    if (selected) { try { hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY }); } catch { /* Fall back to the clicked block when coordinates are unavailable. */ } }
    const insideSelection = hit ? hit.pos >= editor.state.selection.from && hit.pos <= editor.state.selection.to : !!nativeRange && Array.from(nativeRange.getClientRects()).some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
    if (selected && insideSelection) { setMenu({ anchor: makeAnchor(props.content, selected.start, selected.end), x: event.clientX, y: event.clientY }); return; }
    let pos: number;
    try { pos = editor.view.posAtDOM(target, 0); } catch {
      const item = target.closest<HTMLElement>('[data-review-item]')?.dataset.reviewItem;
      const source = props.changes.find(c => c.id === item)?.start ?? props.comments.find(c => c.id === item)?.anchor?.start;
      pos = source !== undefined ? sourceToPosition(parsed.current, source, 1) : editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.selection.from;
    }
    const t = blockTargets(pos, target, event.clientX, event.clientY);
    if (t) setMenu({ ...t, x: event.clientX, y: event.clientY });
  }
  return <div ref={host} className="dr-editor-host" onClick={e => { if (!host.current?.contains(e.target as Node) || window.getSelection()?.isCollapsed === false) return; const target = (e.target as HTMLElement).closest<HTMLElement>('[data-comment-id],[data-change-id]'); const id = target?.dataset.commentId ?? target?.dataset.changeId; if (id) props.onPick(id); }} onContextMenu={contextComment} onPointerDownCapture={e => { if (e.button === 0 && host.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.dr-floating')) { props.onDeselect?.(); setMenu(null); toolbarInteraction.current = false; linkEditing.current = false; setBar(null); } }} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) { e.preventDefault(); if (editor && parsed.current) { const at = positionToSource(parsed.current, editor.state.selection.from, 1), rect = editor.view.coordsAtPos(editor.state.selection.from); setBar({ range: selection() ?? { start: at, end: at }, top: Math.max(8, rect.top - 80), left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), maxWidth: Math.min(520, window.innerWidth - 16), caretLink: editor.state.selection.empty && editor.isActive('link') }); setLinkRequest(x => x + 1); } } if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) { e.preventDefault(); const range = selection(); if (range) props.onComment(range); else if (editor && parsed.current && props.onElementComment) { const rect = editor.view.coordsAtPos(editor.state.selection.from), t = blockTargets(editor.state.selection.from, editor.view.dom, rect.left, rect.top); if (t) props.onElementComment(t.anchor, t.choices); } } if (e.key === 'Escape') { props.onDeselect?.(); setMenu(null); } }}>{editor && inTable && props.editable !== false && <div className="dr-table-controls" role="toolbar" aria-label="Table editing" onMouseDown={e => e.preventDefault()}>
      <button type="button" onClick={() => { const selected = editor.state.selection; let cell = selected.$from; for (let d = cell.depth; d > 0; d--) if (['tableCell', 'tableHeader'].includes(cell.node(d).type.name)) { cell = editor.state.doc.resolve(cell.before(d)); break; } try { editor.view.dispatch(editor.state.tr.setSelection(CellSelection.rowSelection(cell))); editor.view.focus(); } catch { /* Selection changed outside the table. */ } }}>Select row</button>
      <button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</button>
      <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>Add row</button>
      <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>Add column</button>
      <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</button>
      <button type="button" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button>
    </div>}<EditorContent editor={editor} />{editor && bar && <FormatBar key={`${bar.range.start}:${bar.range.end}`} editor={editor} {...bar} toolbarRef={toolbar} onInteraction={active => { toolbarInteraction.current = active; }} linkRequest={linkRequest} onLinkMode={open => { linkEditing.current = open; if (open) setLinkRequest(0); }} onComment={r => { setBar(null); props.onComment(r); }} />}{menu && <CommentMenu target={menu} close={closeMenu} choose={anchor => setMenu({ ...menu, anchor })} comment={props.onElementComment!} />}</div>;
});
