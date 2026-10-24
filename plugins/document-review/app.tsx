import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, useBbNavigate, useComposer, experimental_saveFile, type PluginFileOpenerProps, type PluginMessageDirectiveProps, type PluginThreadPanelProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract';
import { makeAnchor, reviewPrompt, type Anchor, type Change, type Comment, type Session, type HistoryEntry, type CommentAuthor } from './model';
import { editUntrackedDocument, editDocument, proposeDocument, mergeConcurrent } from './review-state';
import { ReviewWorkspace } from './ReviewWorkspace';
import { useDismissal } from './useDismissal';
import { HtmlDocument } from './HtmlDocument';
import { targetLabel } from './comment-target';
import { isHtml, describeHtmlUpdate } from './html-document';
import { RichDocument, type RichDocumentHandle } from './RichDocument';
import { RawDocument } from './RawDocument';
import './styles.css';

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
function Button({ children, primary, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) { return <button type="button" className={`dr-button${primary ? ' dr-primary' : ''}`} {...rest}>{children}</button>; }
function Notice({ children }: { children: ReactNode }) { return <div className="dr-notice">{children}</div>; }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Serializes local edits/actions, while optimistic typing stays responsive.
 * A remote proposal is merged with buffered typing before either is displayed. */
function useDocument(id: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [server, setServer] = useState<Session | null>(null), [error, setError] = useState(''), [tick, setTick] = useState(0), [busy, setBusy] = useState(false);
  const latest = useRef<Session | null>(null), draft = useRef<{ base: string; content: string; trackChanges: boolean } | null>(null), queue = useRef(Promise.resolve<unknown>(undefined));
  const receive = useCallback((s: Session) => {
    const previous = latest.current;
    if (previous?.id === s.id && s.revision <= previous.revision) return;
    // Metadata-only updates must not invalidate HTML diff/preview caches.
    if (previous?.id === s.id && previous.changes.length === s.changes.length && s.changes.every((c, i) => { const p = previous.changes[i]!; return c.id === p.id && c.start === p.start && c.end === p.end && c.before === p.before && c.after === p.after && c.source === p.source && c.decision === p.decision; })) s = { ...s, changes: previous.changes };
    latest.current = s; setServer(s);
  }, []);
  const refreshing = useRef<Promise<void> | null>(null), refreshAgain = useRef(false);
  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const work = (async () => { try { receive(await rpc.call('get', { id })); } catch (e) { setError(errorText(e)); } })();
    refreshing.current = work; void work.finally(() => { if (refreshing.current === work) refreshing.current = null; if (refreshAgain.current) { refreshAgain.current = false; void refresh(); } }); return work;
  }, [id, rpc, receive]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRealtime('changed', payload => { const event = payload as { id?: string; revision?: number } | null; if (event?.id === id && (event.revision === undefined || event.revision > (latest.current?.revision ?? 0))) { if (refreshing.current) refreshAgain.current = true; void refresh(); } });
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === 'connected') void refresh(); }, [connection, refresh]);
  useEffect(() => {
    const activate = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', activate); document.addEventListener('visibilitychange', activate);
    return () => { window.removeEventListener('focus', activate); document.removeEventListener('visibilitychange', activate); };
  }, [rpc, refresh]);
  function enqueue<T>(fn: () => Promise<T>): Promise<T> { const next = queue.current.then(fn, fn); queue.current = next.catch(() => undefined); return next; }
  async function flush() {
    const snapshot = draft.current, base = latest.current;
    if (!snapshot || !base) return;
    const result = await rpc.call('edit', { id, revision: base.revision, baseContent: snapshot.base, content: snapshot.content, trackChanges: snapshot.trackChanges });
    if (draft.current === snapshot) draft.current = null;
    else if (draft.current) draft.current = { trackChanges: draft.current.trackChanges, base: result.content, content: mergeConcurrent(snapshot.content, result.content, draft.current.content) };
    receive(result); setTick(x => x + 1);
  }
  useEffect(() => {
    if (!draft.current) return;
    const timer = setTimeout(() => { void enqueue(async () => { try { await flush(); setError(''); } catch (e) { setError(errorText(e)); } }); }, 200);
    return () => clearTimeout(timer);
  }, [tick]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => { if (draft.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', leaving); return () => window.removeEventListener('beforeunload', leaving);
  }, []);
  useEffect(() => () => { if (draft.current) void enqueue(flush).catch(() => undefined); }, []);
  function type(content: string) {
    const base = latest.current; if (!base) return;
    draft.current = { base: draft.current?.base ?? base.content, content, trackChanges: draft.current?.trackChanges ?? base.trackChanges }; setTick(x => x + 1);
  }
  const view = useMemo(() => {
    if (!server) return null;
    if (!draft.current) return server;
    let text = draft.current.content;
    try { text = mergeConcurrent(draft.current.base, server.content, text); } catch { /* Keep the recoverable local draft visible. */ }
    const copy = structuredClone(server); if (draft.current.trackChanges) proposeDocument(copy, text, 'user'); else editUntrackedDocument(copy, text); return copy;
  }, [server, tick]);
  function act(work: (s: Session) => Promise<Session>) {
    return enqueue(async () => {
      setBusy(true); setError('');
      try { await flush(); const s = latest.current; if (!s) return null; const result = await work(s); receive(result); return result; }
      catch (e) { setError(errorText(e)); void refresh(); return null; } finally { setBusy(false); }
    });
  }
  function checkpoint() { return enqueue(async () => { try { await flush(); setError(''); } catch (e) { setError(errorText(e)); } }); }
  return { checkpoint, rpc, view, busy, buffering: !!draft.current, error, setError, type, act, refresh, discardLocal: () => { draft.current = null; setTick(x => x + 1); setError(''); void refresh(); } };
}
function AgentRequest({ session, inThread }: { session: Session; inThread: boolean }) { return inThread ? <ThreadRequest session={session} /> : <NewRequest session={session} />; }
function ThreadRequest({ session }: { session: Session }) {
  const composer = useComposer();
  return <Button onClick={() => { composer.insert(reviewPrompt(session), { at: 'end', block: true }); composer.focus(); }} title="Prepare a chat request using the current document and its comments. You send it when ready.">Ask agent to revise</Button>;
}
function NewRequest({ session }: { session: Session }) {
  const nav = useBbNavigate(); return <Button onClick={() => nav.toCompose({ initialPrompt: reviewPrompt(session), focusPrompt: true })} title="Prepare a new chat draft with this document and its comments. You send it when ready.">Ask agent to revise</Button>;
}
function commentShortcut(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); e.currentTarget.form?.requestSubmit(); }
}
function Author({ author, event = false }: { author?: CommentAuthor; event?: boolean }) {
  const kind = author?.kind ?? (event ? 'system' : 'unknown');
  return <span className={`dr-author dr-author-${kind}`} title={author?.threadTitle ? `Agent thread: ${author.threadTitle}` : undefined}>{kind === 'user' ? 'You' : kind === 'unknown' ? 'Unknown author' : kind === 'system' ? 'Document Review' : `Agent · ${author?.name ?? 'Agent'}`}{author?.threadTitle && <span className="dr-author-thread">{author.threadTitle}</span>}</span>;
}
function CommentCard({ comment: c, active, disabled, locate, resolve, remove, reply }: { comment: Comment; active: boolean; disabled: boolean; locate: () => void; resolve: () => void; remove: () => void; reply: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState(''), [writing, setWriting] = useState(false), [posting, setPosting] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  return <section className={`dr-card ${active ? 'dr-active-card' : ''}`} data-sidebar-item={c.id}>
    <button className="dr-card-heading" aria-label={`Comment ${c.status === 'resolved' ? 'Resolved' : c.status === 'addressed' ? 'Replied' : 'Open'}`} onClick={locate}><Author author={c.author} /><span className="dr-badge">{c.status === 'resolved' ? 'Resolved' : c.status === 'addressed' ? 'Replied' : 'Open'}</span></button>
    {c.anchor && <button className="dr-quote" onClick={locate}>{c.anchor.orphaned ? 'Target unavailable · ' : c.anchor.removed ? 'Passage removed · ' : ''}{c.anchor.element ? targetLabel(c.anchor) : `“${c.anchor.quote.slice(0, 180)}”`}</button>}
    <p className="dr-comment-body">{c.body}</p>
    {c.replies.map((r, i) => <div className={`dr-reply ${r.kind && r.kind !== 'reply' ? 'dr-thread-event' : ''}`} key={i}><Author author={r.author} event={!!r.kind && r.kind !== 'reply'} /><span>{r.body}</span></div>)}
    {confirmDelete ? <div className="dr-delete-confirm" role="group" aria-label="Confirm comment deletion"><p>Delete this conversation and all replies?</p><div className="dr-row"><Button disabled={disabled || posting} onClick={remove}>Confirm</Button><Button onClick={() => setConfirmDelete(false)}>Cancel</Button></div></div> : <div className="dr-row"><Button disabled={disabled} onClick={resolve} title={c.status === 'resolved' ? 'Return this conversation to the active review.' : 'Dismiss this completed thread. You can reopen or reply from History for 14 days.'}>{c.status === 'resolved' ? 'Reopen' : 'Resolve'}</Button><Button disabled={disabled || posting} onClick={() => setWriting(!writing)} title="Add another instruction or respond in this comment thread.">Reply</Button><Button disabled={disabled || posting} onClick={() => setConfirmDelete(true)} title="Permanently delete this comment, its replies, and archived copies. This does not change document text.">Delete</Button></div>}
    {writing && <form onSubmit={e => { e.preventDefault(); if (body.trim() && !disabled && !posting) { setPosting(true); void reply(body).then(ok => { if (ok) { setBody(''); setWriting(false); } }).finally(() => setPosting(false)); } }}><textarea autoFocus aria-label="Comment reply" onKeyDown={commentShortcut} placeholder="Reply… (⌘/Ctrl+Enter to post)" value={body} onChange={e => setBody(e.target.value)} maxLength={20_000} /><Button type="submit" disabled={disabled || posting || !body.trim()}>Post reply</Button></form>}
  </section>;
}
function ChangeCard({ change: c, active, disabled, locate, decide, html = false, content = '' }: { html?: boolean; content?: string; change: Change; active: boolean; disabled: boolean; locate: () => void; decide: (decision: 'accepted' | 'rejected') => void }) {
  const labels = useMemo(() => html ? describeHtmlUpdate(content, c) : [], [html, content, c]);
  return <section className={`dr-card ${active ? 'dr-active-card' : ''}`} data-sidebar-item={c.id}>
    <button className="dr-card-heading" onClick={locate}><span>{html ? 'HTML update' : c.source === 'user' ? 'Your edit' : 'Suggested edit'}</span><span className="dr-badge">Pending</span></button>
    <div className="dr-row dr-decision-actions"><Button disabled={disabled} onClick={() => decide('accepted')} title="Keep this wording, archive the suggestion, and move to the next suggested edit.">✓ Accept</Button><Button disabled={disabled} onClick={() => decide('rejected')} title="Restore the previous wording and archive the suggestion. Your scroll position stays here.">× Reject</Button></div>
    {html ? <><p className="dr-html-change-labels">{labels.join(' · ')}</p><p className="dr-tiny">Review this update together to keep the HTML intact. The page shows the proposed result.</p><details><summary>Show code</summary>    <div className="dr-change-preview">{c.before && <del>{c.before.slice(0, 1200)}{c.before.length > 1200 ? '…' : ''}</del>}{c.after && <ins>{c.after.slice(0, 1200)}{c.after.length > 1200 ? '…' : ''}</ins>}</div></details></> :     <div className="dr-change-preview">{c.before && <del>{c.before.slice(0, 1200)}{c.before.length > 1200 ? '…' : ''}</del>}{c.after && <ins>{c.after.slice(0, 1200)}{c.after.length > 1200 ? '…' : ''}</ins>}</div>}
  </section>;
}
function HistoryCard({ item, load, filename }: { item: Omit<HistoryEntry, 'changes' | 'snapshot' | 'comment'>; load: () => Promise<HistoryEntry>; filename: string }) {
  const [detail, setDetail] = useState<HistoryEntry | null>(null), [error, setError] = useState('');
  return <section className="dr-card dr-history-card"><button className="dr-card-heading" onClick={() => load().then(setDetail, e => setError(errorText(e)))}><span>{item.summary}</span><span className="dr-badge">{item.kind.replace('-', ' ')}</span></button><time className="dr-tiny">{new Date(item.createdAt).toLocaleString()}</time>{error && <p role="alert">{error}</p>}{detail?.changes?.map((c, i) => <div key={i} className="dr-change-preview"><del>{c.before}</del><ins>{c.after}</ins></div>)}{detail?.comment && <><div className="dr-quote">{detail.comment.anchor?.quote}</div><Author author={detail.comment.author} /><p className="dr-comment-body">{detail.comment.body}</p>{detail.comment.replies.map((r, i) => <div className={`dr-reply ${r.kind && r.kind !== 'reply' ? 'dr-thread-event' : ''}`} key={i}><Author author={r.author} event={!!r.kind && r.kind !== 'reply'} /><span>{r.body}</span></div>)}</>}{detail?.snapshot !== undefined && <Button onClick={() => experimental_saveFile({ fileName: `previous-${filename}`, blob: new Blob([detail.snapshot!], { type: 'text/markdown;charset=utf-8' }) })}>Download previous draft</Button>}</section>;
}

export function ReviewEditor({ id, inThread = false, onBack }: { id: string; inThread?: boolean; onBack?: () => void }) {
  const doc = useDocument(id), s = doc.view;
  const html = !!s && isHtml(s.path);
  const rich = useRef<RichDocumentHandle>(null), sidebar = useRef<HTMLDivElement>(null), commentInput = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLElement>(null);
  const [active, setActive] = useState(''), [anchor, setAnchor] = useState<Anchor | null>(null), [body, setBody] = useState(''), [writing, setWriting] = useState(false), [switchingTracking, setSwitchingTracking] = useState(false), [showHistory, setShowHistory] = useState(false);
  const [draftChoices, setDraftChoices] = useState<Anchor[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const [htmlInteractive, setHtmlInteractive] = useState(() => { try { return localStorage.getItem(`dr-interactive:${id}`) !== 'false'; } catch { return true; } });
  const [history, setHistory] = useState<Omit<HistoryEntry, 'changes' | 'snapshot' | 'comment'>[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (showHistory) void doc.rpc.call('history', { id }).then(items => { if (!cancelled) setHistory(items); }, e => { if (!cancelled) doc.setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [showHistory, s?.revision, id, doc.rpc]);
  useEffect(() => { if (s?.comments.find(c => c.id === active)?.status === 'resolved') setActive(''); }, [s, active]);
  function beginAnchoredComment(next: Anchor | null, choices: Anchor[] = []) {
    setSidebarHidden(false); setAnchor(next); setDraftChoices(choices); setWriting(true); setActive(''); setShowHistory(false);
    requestAnimationFrame(() => { commentInput.current?.focus(); commentInput.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  }
  function pickInDocument(itemId: string) {
    setSidebarHidden(false); setActive(itemId); setShowHistory(false);
    requestAnimationFrame(() => sidebar.current?.querySelector(`[data-sidebar-item="${itemId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  async function deleteComment(commentId: string) {
    const result = await doc.act(current => doc.rpc.call('deleteComment', { id, revision: current.revision, commentId }));
    if (result) { setActive(current => current === commentId ? '' : current); if (showHistory) void doc.rpc.call('history', { id }).then(setHistory, e => doc.setError(errorText(e))); }
  }
  function locate(itemId: string) {
    setSidebarHidden(false);
    const resolved = s?.comments.some(c => c.id === itemId && c.status === 'resolved') ?? false;
    setActive(resolved ? '' : itemId); setShowHistory(resolved);
    const c = s?.changes.find(c => c.id === itemId), note = s?.comments.find(c => c.id === itemId);
    const range = c ?? note?.anchor;
    if (range) requestAnimationFrame(() => rich.current?.scrollTo(range.start, range.end, itemId));
    requestAnimationFrame(() => sidebar.current?.querySelector(`[data-sidebar-item="${itemId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  function beginComment(range?: { start: number; end: number }) {
    if (!s) return;
    try { beginAnchoredComment(range ? makeAnchor(s.content, range.start, range.end) : null); } catch (e) { doc.setError(errorText(e)); }
  }
  async function decide(c: Change, decision: 'accepted' | 'rejected') {
    const oldTop = scroll.current?.scrollTop ?? 0;
    const result = await doc.act(current => {
      // Newly typed suggestions have provisional UI IDs until the draft flushes.
      const change = current.changes.find(x => x.id === c.id) ?? current.changes.find(x => x.start === c.start && x.before === c.before && x.after === c.after);
      if (!change) throw new Error('This edit changed while you were deciding. Review its latest wording and try again.');
      return doc.rpc.call('decide', { id, revision: current.revision, changeId: change.id, decision });
    });
    if (!result) return;
    if (decision === 'accepted') {
      const next = result.changes.find(x => x.start >= c.start) ?? result.changes[0];
      setActive(next?.id ?? ''); if (next) requestAnimationFrame(() => requestAnimationFrame(() => { rich.current?.scrollTo(next.start, next.end, next.id); sidebar.current?.querySelector(`[data-sidebar-item="${next.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }));
    } else { setActive(''); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = oldTop; }); }
  }
  const flow = useMemo(() => s ? [
    ...s.changes.map(c => ({ type: 'change' as const, position: c.start, id: c.id, value: c })),
    ...s.comments.filter(c => c.status !== 'resolved').map(c => ({ type: 'comment' as const, position: c.anchor?.start ?? Number.MAX_SAFE_INTEGER, id: c.id, value: c })),
    ...(writing ? [{ type: 'draft' as const, position: anchor?.start ?? Number.MAX_SAFE_INTEGER, id: '__draft', value: null }] : []),
  ].sort((a, b) => a.position - b.position || (a.type === 'draft' ? 1 : b.type === 'draft' ? -1 : a.id.localeCompare(b.id))) : [], [s, writing, anchor]);
  const presence = useDismissal(flow);
  if (!s) return <div className="dr-root dr-loading">{doc.error ? <p role="alert">{doc.error}</p> : 'Opening document…'}<Button onClick={() => void doc.refresh()}>Try again</Button></div>;
  const commentDraft = <form className="dr-card dr-compose-comment" onSubmit={e => { e.preventDefault(); if (!body.trim() || doc.busy) return; void doc.act(async current => { const result = await doc.rpc.call('comment', { id, revision: current.revision, body, anchor }); setWriting(false); setBody(''); setAnchor(null); setActive(result.comments.at(-1)?.id ?? ''); return result; }); }}>
              <strong>{anchor?.element ? targetLabel(anchor) : anchor ? 'Comment on selected text' : 'Whole document'}</strong>{draftChoices.length > 1 && <div className="dr-scope-options" aria-label="Comment scope">{draftChoices.map(a => <Button key={`${a.element?.tag}:${a.element?.selector}:${a.start}:${a.end}`} aria-pressed={a.start === anchor?.start && a.end === anchor?.end} onClick={() => setAnchor(a)}>{targetLabel(a, false)}</Button>)}</div>}{anchor && <div className="dr-quote">“{anchor.quote.slice(0, 200)}”</div>}<textarea ref={commentInput} aria-label="New comment" onKeyDown={commentShortcut} placeholder="What should change? (⌘/Ctrl+Enter to post)" value={body} onChange={e => setBody(e.target.value)} maxLength={20_000} /><div className="dr-row"><Button primary type="submit" disabled={doc.busy || !body.trim()}>Post comment</Button><Button onClick={() => { setWriting(false); setAnchor(null); setBody(''); setDraftChoices([]); }}>Cancel</Button></div>
            </form>;
  const download = () => experimental_saveFile({ fileName: s.title, blob: new Blob([s.content], { type: 'text/markdown;charset=utf-8' }) });
  return <div className="dr-root dr-editor-layout" onKeyDownCapture={e => { if (e.key === 'Escape') { setActive(''); if (writing && !body.trim()) { setWriting(false); setAnchor(null); } } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void doc.checkpoint(); } }}>
    <header className="dr-toolbar"><div className="dr-title">{onBack && <Button aria-label="Back to documents" onClick={onBack}>←</Button>}<strong title={s.path}>{s.title}</strong><span className="dr-doc-type">{html ? 'HTML' : /\.(txt|text)$/i.test(s.path) ? 'Text' : 'Markdown'}</span></div><div className="dr-editor-actions">{html && <Button aria-pressed={htmlInteractive} title="Run the document’s controls in an isolated preview. Right-click or use ⌘/Ctrl+Alt+M to comment. External navigation, API requests and form submissions stay disabled." onClick={() => { const next = !htmlInteractive; setHtmlInteractive(next); try { localStorage.setItem(`dr-interactive:${id}`, String(next)); } catch {} }}>Interaction: {htmlInteractive ? 'On' : 'Off'}</Button>}{!html && <><Button title={`Switch to ${rawMarkdown ? 'rich editing' : 'raw Markdown'}. Both views use the same tracking setting.`} onClick={() => setRawMarkdown(current => !current)}>View: {rawMarkdown ? 'Raw' : 'Rich'}</Button><Button role="switch" aria-checked={s.trackChanges} disabled={doc.busy || switchingTracking} className={`dr-button dr-track-toggle ${s.trackChanges ? 'dr-tracking-on' : ''}`} title="Track your typing and formatting as suggestions you can accept or reject. Turning it off writes edits to committed text automatically. With tracking off, editing a suggestion commits your result and archives that suggestion; unrelated suggestions remain pending." onClick={() => { setSwitchingTracking(true); void doc.act(current => doc.rpc.call('tracking', { id, revision: current.revision, enabled: !current.trackChanges })).finally(() => setSwitchingTracking(false)); }}>Track changes: {s.trackChanges ? 'On' : 'Off'}</Button><Button aria-label="Undo typing" title="Undo your last editor action" onClick={() => rich.current?.undo()}>↶</Button><Button aria-label="Redo typing" title="Redo your last editor action" onClick={() => rich.current?.redo()}>↷</Button></>}</div><div className="dr-toolbar-actions"><Button aria-expanded={!sidebarHidden} aria-controls={`dr-review-sidebar-${id}`} onClick={() => setSidebarHidden(!sidebarHidden)} title="Show or hide comments, suggestions, and history. Starting a comment reopens this sidebar.">{sidebarHidden ? 'Show review' : 'Hide review'}</Button><Button aria-pressed={showHistory} onClick={() => { setShowHistory(!showHistory); setSidebarHidden(false); }} title="Show dismissed suggestions and document history from the last 14 days.">{showHistory ? 'Active review' : 'History'}</Button></div></header>
    {doc.error && <div role="alert" className="dr-error">{doc.error}{doc.buffering && <div className="dr-row"><Button onClick={() => void doc.checkpoint()}>Retry storing edits</Button><Button onClick={download}>Download local draft</Button><Button onClick={doc.discardLocal}>Use latest document</Button></div>}</div>}
    {s.notice && <div className="dr-notice dr-external-notice">{s.notice}</div>}
    <ReviewWorkspace hidden={sidebarHidden} document={<main ref={scroll} className={`dr-document-scroll ${html ? 'dr-html-scroll' : ''}`} onPointerDownCapture={e => { if (e.button === 0) setActive(''); }}>{html ? <HtmlDocument ref={rich} interactive={htmlInteractive} id={id} content={s.content} changes={s.changes} comments={s.comments} active={active} draft={writing ? anchor : null} onComment={beginAnchoredComment} onDeselect={() => setActive('')} onPick={pickInDocument} /> : <div className={`dr-paper ${rawMarkdown ? 'dr-raw-paper' : ''}`}>{rawMarkdown ? <RawDocument ref={rich} content={s.content} editable={!switchingTracking} onChange={doc.type} onComment={beginComment} onDeselect={() => setActive('')} /> : <RichDocument ref={rich} content={s.content} changes={s.changes} comments={s.comments} plain={/\.(txt|text)$/i.test(s.path)} editable={!switchingTracking} active={active} onChange={doc.type} onComment={beginComment} onPick={pickInDocument} onDeselect={() => setActive('')} draftAnchor={writing ? anchor : null} onElementComment={beginAnchoredComment} />}</div>}</main>} sidebar={<aside id={`dr-review-sidebar-${id}`} hidden={sidebarHidden} className="dr-sidebar" aria-label="Comments and suggestions"><header className="dr-sidebar-heading"><strong>{showHistory ? 'History · last 14 days' : 'Comments & suggestions'}</strong>{!showHistory && <><span className="dr-badge">{flow.length}</span><Button disabled={doc.busy || !s.changes.length} title={`Accept all ${s.changes.length} pending changes and write the document once. Comments remain open.`} onClick={() => { void doc.act(current => doc.rpc.call('acceptAll', { id, revision: current.revision })).then(result => { if (result) setActive(''); }); }}>Accept all changes</Button></>}{showHistory && <Button disabled={doc.busy || (!history.length && !s.comments.some(c => c.status === 'resolved'))} title="Permanently delete this document’s archived history, recovery drafts, and resolved comments. Active comments and pending edits are kept." onClick={() => { void doc.act(current => doc.rpc.call('clearHistory', { id, revision: current.revision })).then(result => { if (result) { setHistory([]); setActive(''); } }); }}>Clear history</Button>}</header>
        <div className="dr-sidebar-content" ref={sidebar} onPointerDown={e => { if (e.target === e.currentTarget) setActive(''); }}>
          {showHistory ? <>{s.comments.filter(c => c.status === 'resolved').map(c => <CommentCard key={c.id} comment={c} remove={() => void deleteComment(c.id)} active={active === c.id} disabled={doc.busy} locate={() => locate(c.id)} resolve={() => { void doc.act(current => doc.rpc.call('commentStatus', { id, revision: current.revision, commentId: c.id, status: 'open' })).then(result => { if (result) { locate(c.id); setShowHistory(false); } }); }} reply={async body => { const result = await doc.act(current => doc.rpc.call('reply', { id, revision: current.revision, commentId: c.id, body })); if (result) { locate(c.id); setShowHistory(false); } return !!result; }} />)}{history.length === 0 && !s.comments.some(c => c.status === 'resolved') && <Notice>No archived changes yet.</Notice>}{history.filter(h => h.kind !== 'comment-resolved').map(h => <HistoryCard key={h.id} item={h} filename={s.title} load={() => doc.rpc.call('historyEntry', { id, eventId: h.id })} />)}{history.length > 0 && history.length % 50 === 0 && <Button onClick={() => doc.rpc.call('history', { id, offset: history.length }).then(items => setHistory(current => [...current, ...items]), e => doc.setError(errorText(e)))}>Show older history</Button>}</> : <>

            {flow.length === 0 && !writing && <Notice>{html ? 'Right-click an element or selected text to leave a comment.' : 'Select text to comment, or start typing. Tracked edits and comments appear here together.'}</Notice>}
            {presence.items.map(item => <div key={item.id} className={`dr-flow-item ${presence.exiting.has(item.id) ? 'dr-flow-exit' : ''}`} inert={presence.exiting.has(item.id) || undefined} aria-hidden={presence.exiting.has(item.id) || undefined}><div className="dr-flow-inner">{item.type === 'draft' ? <div key={item.id} data-sidebar-item="__draft">{commentDraft}</div> : item.type === 'change' ? <ChangeCard key={item.id} html={html} content={s.content} change={item.value} active={active === item.id} disabled={doc.busy} locate={() => locate(item.id)} decide={d => void decide(item.value, d)} /> : <CommentCard key={item.id} comment={item.value} remove={() => void deleteComment(item.id)} active={active === item.id} disabled={doc.busy} locate={() => locate(item.id)} resolve={() => { setActive(''); void doc.act(current => doc.rpc.call('commentStatus', { id, revision: current.revision, commentId: item.id, status: 'resolved' })); }} reply={async body => !!await doc.act(current => doc.rpc.call('reply', { id, revision: current.revision, commentId: item.id, body }))} />}</div></div>)}
          </>}
        </div>
        <footer className="dr-sidebar-footer"><AgentRequest session={s} inThread={inThread} /><p className="dr-tiny">Prepares a chat request with this document and its comments. You send it when ready.</p></footer>
      </aside>} />
  </div>;
}
function ReviewHome({ selectedId, onSelect, inThread = false }: { selectedId?: string; onSelect?: (id: string | null) => void; inThread?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [localId, setLocalId] = useState<string | null>(null), [path, setPath] = useState(''), [host, setHost] = useState('');
  const [reviews, setReviews] = useState<{ id: string; path: string; title: string; hostId: string; pending: number; comments: number; saved: boolean; updatedAt: string }[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const choose = (id: string | null) => onSelect ? onSelect(id) : setLocalId(id);
  const refresh = useCallback(() => { rpc.call('list').then(setReviews, e => setError(String(e))); }, [rpc]);
  const reviewing = !!(selectedId || localId);
  useEffect(() => { if (!reviewing) refresh(); }, [refresh, reviewing]); useRealtime('changed', () => { if (!reviewing) refresh(); });
  if (selectedId || localId) return <ReviewEditor key={selectedId ?? localId!} id={selectedId ?? localId!} inThread={inThread} onBack={() => choose(null)} />;
  return <div className="dr-root dr-home"><div className="dr-intro"><div className="dr-eyebrow">DOCUMENT REVIEW</div><h1>Your document.<br /><span>Your final word.</span></h1><p>Write, format, comment, and review agent edits in one document. Accept changes when ready.</p></div><form className="dr-open-form" onSubmit={async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { const s = await rpc.call('open', { path, ...(host ? { hostId: host } : {}) }); choose(s.id); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }}><label htmlFor="dr-path">Open a Markdown, HTML, or text document</label><div className="dr-row"><input id="dr-path" placeholder="/absolute/path/to/document.md" value={path} onChange={e => setPath(e.target.value)} required /><Button primary type="submit" disabled={busy || !path.trim()}>{busy ? 'Opening…' : 'Open document'}</Button></div><details><summary>Another host</summary><input aria-label="Host ID" placeholder="Host ID (defaults to this BB server’s machine)" value={host} onChange={e => setHost(e.target.value)} /></details></form>{error && <div role="alert" className="dr-error">{error}</div>}<div className="dr-recent"><h2>Recent reviews</h2>{reviews.length === 0 ? <Notice>Open a file here, or right-click a document link and choose Open with → Document Review.</Notice> : reviews.map(r => <button className="dr-review-row" key={r.id} onClick={() => choose(r.id)}><span><strong>{r.title}</strong><small>{r.path}</small></span><span className="dr-badge">{r.pending} pending · {r.comments} comments</span></button>)}</div></div>;
}
function ReviewsPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate(); const id = /^review_[a-z0-9-]+$/.test(subPath) ? subPath : undefined;
  return <ReviewHome selectedId={id} onSelect={id => nav.toPluginPanel('reviews', { subPath: id ?? '' })} />;
}
function ReviewPanel({ params }: PluginThreadPanelProps) {
  const id = params && typeof params === 'object' && !Array.isArray(params) && typeof params.id === 'string' ? params.id : undefined;
  return <ReviewHome selectedId={id} inThread />;
}
function FileReview({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>(); const [id, setId] = useState<string | null>(null), [error, setError] = useState(''), [original, setOriginal] = useState(false);
  const key = JSON.stringify(source);
  useEffect(() => { let current = true; setId(null); setError(''); rpc.call('open', { path, source }).then(s => { if (current) setId(s.id); }, e => { if (current) setError(String(e)); }); return () => { current = false; }; }, [rpc, path, key]);
  if (original) return <Original />;
  if (error) return <div className="dr-root dr-loading"><p role="alert">{error}</p><Button onClick={() => setOriginal(true)}>Open BB preview</Button></div>;
  return id ? <ReviewEditor key={id} id={id} inThread={source.threadId !== null} /> : <div className="dr-root dr-loading">Opening review…</div>;
}
function ReviewDirective({ attributes }: PluginMessageDirectiveProps) {
  const nav = useBbNavigate(); const id = attributes.id;
  if (!id || !/^review_[a-z0-9-]+$/.test(id)) return null;
  return <div className="dr-root dr-directive"><strong>Document rewrite ready for review</strong><Button primary onClick={() => { if (!nav.openThreadPanel({ actionId: 'review', title: 'Document Review', params: { id } })) nav.toPluginPanel('reviews', { subPath: id }); }}>Review changes</Button></div>;
}
function ReviewSettings() {
  return <div className="dr-settings-help"><p>Select text in Markdown to format or comment using the floating bar. Right-click any Markdown block or HTML element and choose <strong>Comment here</strong>. An existing text selection becomes the comment target. Shift + right-click opens the native browser menu.</p><p><strong>View: Rich / Raw</strong> is one button that switches between formatted editing and the complete Markdown source. Both track edits the same way. Click inside a rich table to select or delete rows and columns. Select row highlights the complete row; Delete or Backspace removes selected rows. Raw view can edit every Markdown construct without conversion.</p><p><strong>Enter</strong> inserts a new line in a comment or reply. <strong>⌘+Enter / Ctrl+Enter</strong> posts it. <strong>⌘/Ctrl+Alt+M</strong> comments on highlighted text in either format. Without a selection it starts an HTML element picker, or comments on the current Markdown block. Escape cancels picking or deselects a comment.</p><p><strong>Track changes</strong> controls your Markdown typing and formatting; agent proposals are always tracked. With tracking on, edits stay out of the file until accepted. Turning tracking off writes personal edits to committed text automatically. With tracking off, edits apply directly even across proposed and existing text. Edited suggestions are archived and your resulting wording is written; unrelated suggestions stay pending. <strong>Accept</strong> keeps the edit and moves to the next suggestion. <strong>Accept all changes</strong> accepts every pending suggestion in one file write and archives them, keeping comments open. <strong>Reject</strong> restores the previous text and keeps your position. Both archive the decision.</p><p><strong>Resolve</strong> archives a conversation and excludes it from agent feedback. <strong>Delete</strong> asks for confirmation, then permanently removes the thread, replies, and archived copies. <strong>Reply</strong> adds to its thread and reopens a resolved conversation. Comments and replies show their author; older entries without authors are labeled Unknown author. Agent revision/decision notices are marked Document Review.</p><p><strong>Hide review / Show review</strong> toggles the sidebar. Starting a comment or clicking its highlighted area reopens it and brings the thread into view. Drag its divider to resize it, or focus the divider and use arrow keys. Your preferred size is remembered in this browser.</p><p><strong>History</strong> contains archived changes and resolved conversations for 14 days. <strong>Clear history</strong> permanently removes this document’s archived changes, resolved conversations and recovery drafts while keeping active comments, pending edits and current text.</p><p><strong>Review storage is automatic.</strong> Tracked edits and agent proposals stay in BB until accepted. Accept writes just that change to the file; Reject leaves it out. With tracking off, edits to committed text write automatically after a brief pause. Directly editing a suggestion replaces it with your result. Unrelated pending suggestions remain excluded. Cmd/Ctrl+S flushes the current review without accepting suggestions or writing pending text. <strong>Ask agent to revise</strong> prepares a chat draft you can send. Agents can also find feedback directly with Document Review tools.</p><p>HTML controls run in an isolated preview. Interaction toggles page scripts; right-click or use the comment shortcut to annotate controls. External navigation, API requests, form submissions and access to BB remain disabled. Use comments for HTML source edits. HTML proposals are accepted or rejected together to preserve markup. Comment metadata and preview attributes are kept out of saved files.</p></div>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'usage', title: 'Using Document Review', description: 'Editing, comments, shortcuts, review controls, and saved files.', component: ReviewSettings });
  app.slots.navPanel({ id: 'reviews', path: 'reviews', title: 'Document Review', icon: 'FilePenLine', component: ReviewsPage });
  app.slots.threadPanelAction({ id: 'review', title: 'Document Review', icon: 'FilePenLine', layout: 'flush', component: ReviewPanel });
  app.slots.fileOpener({ id: 'review-markdown', title: 'Document Review', extensions: ['md', 'markdown', 'mdown', 'txt', 'text', 'html', 'htm'], component: FileReview });
  app.slots.messageDirective({ id: 'document-review', component: ReviewDirective });
});
