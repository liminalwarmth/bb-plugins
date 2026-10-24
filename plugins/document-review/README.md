# Document Review for BB

One document workspace for editable Markdown and rendered HTML with contextual formatting, comments, tracked
suggestions from you and agents, and history. Click to type, select to format/comment, and
accept changes when ready.

## When agents use it

Document Review is opt-in: ask for proposed/tracked changes to an existing Markdown
file, or explicitly request Document Review (including its comments or HTML/text
reviews). Ordinary Markdown writing, plan rewrites, and routine edits to documents
an agent already produced do not trigger this workflow. An existing review alone
does not change that. Within a requested review, agents check for comments even
when they have not been pushed into chat.

## Open a document

Choose **Document Review** in BB navigation, enter an absolute Markdown/text
path, or right-click a file link → **Open with → Document Review**. It also
appears in the thread panel's New tab menu. Settings → File openers can make it
your default Markdown opener.

**Hide review / Show review** at the upper right toggles the sidebar. Starting a
comment automatically reopens it, with the draft ready to type. Drag the divider
between the document and sidebar to make comments wider or narrower; both panes
reflow. On narrow panels the sidebar sits below the document and the divider
resizes its height. Arrow keys work when the divider is focused. Size is remembered
in this browser. Usage and shortcut information lives in the plugin’s
**Settings → Using Document Review** section.

The document is the current working copy: user edits, proposed edits, and the
results of accepted/rejected changes all live here. There are no separate
original, proposal, or result copies. Rich and Raw edit this same Markdown working copy.

## Editing and comments

Click the document to type. Select text for the floating formatting bar:
**Bold, Italic, Strikethrough, Inline code, Heading, List, Link, Comment**.
Comment immediately opens and focuses a sidebar draft anchored to that passage.
The header keeps the filename/type, tracking, undo/redo, sidebar toggle, History,
in one compact toolbar. Review storage is automatic. Cmd/Ctrl+S flushes buffered review edits without accepting suggestions. Keyboard shortcuts and Markdown typing shortcuts work
through the editor. The two curved-arrow controls undo/redo editor actions.

**View: Rich / Raw** is a single button that switches between formatted editing and the complete Markdown source.
Raw preserves all syntax and uses the same tracking, comments, and autosave rules.
In rich tables, click a cell for row/column controls. **Select row** highlights
the full row; Delete or Backspace removes selected complete rows. **Delete row**,
**Add row**, **Add column**, **Delete column**, and **Delete table** edit structure.

Comments and suggestions share one sidebar, ordered by their document position.
Click a passage or card to bring its counterpart into view. Selecting text does
not force a review decision. **Track changes** is on by default. Your typing,
deletions, and formatting become suggestions you can accept or reject; continued
typing extends the same suggestion. Turning it off applies future edits directly
and keeps existing suggestions pending. Editing a pending passage while tracking
is on updates that suggestion and preserves its original rejection text. With
tracking off, edits apply directly even across proposed and existing text. Any
suggestion you edit is archived and replaced by your resulting wording; unrelated
suggestions stay pending. Simply turning tracking off does not accept anything.

Comments keep their original quote, conversation, and link to the current passage
through rewrites and accept/reject decisions. Click a comment to outline its
passage in red. A deleted passage keeps a visible **Removed passage** marker,
even after its deletion is accepted. Revision/decision events stay in the same
thread. Resolving a thread does not decide its associated text changes. Open
**History** to reply to or reopen a resolved thread; replying reopens it.

## Point at anything to comment

Right-click a Markdown block or anything in an HTML preview and choose
**Comment here**. Selecting text first targets that selection; otherwise the
comment refers to the paragraph, image, button, card, or area you clicked.
In a comment or reply, Enter starts a new line; **Cmd+Enter / Ctrl+Enter** posts it.
Each message shows **You** or **Agent · provider**, with the agent thread when
available. Older messages without recorded authors say **Unknown author**. Agents
can also start their own comments to flag wording or design issues.

The target has an amber outline while composing, and the draft stays in document
order between its neighboring sidebar items. **Comment scope** choices let you
widen an HTML target to its enclosing card or section. Shift + right-click keeps
the browser's native menu. In HTML, **Cmd/Ctrl+Alt+M** comments on highlighted
text; without a selection it starts an element picker. Escape cancels picking.

A selected comment has a red outline. Clicking the document, its margins,
empty sidebar space, or pressing Escape clears that selection. **Resolve**
removes the comment's decoration immediately and retains its thread in History.
The Link control keeps its text selection while the URL field has focus, accepts
bare domains such as `example.com`, and explains invalid addresses. Click in an existing link for Open, Edit, and Remove; Cmd/Ctrl+K opens the link editor.

## HTML plans and design samples

Open `.html` or `.htm` through the same Document Review opener. HTML renders in
an isolated full-width preview with local images, fonts, and styles served from
the document's permitted root. Remote HTTPS images/styles/fonts are supported.
**Interaction: On** runs page scripts and controls in an opaque-origin sandbox;
filters, accordions, tabs, and client-side controls work alongside comments.
Switch Interaction off for a static preview. Local JavaScript and HTTPS scripts
can load, but API requests, form submissions, external navigation, embedded frames,
and access to BB are disabled. Right-click controls or use Cmd/Ctrl+Alt+M to comment
without activating them. Internal section links and the document’s print control work. Text editing in HTML is deferred to preserve exact source;
use comments to request changes to its text or design.

HTML comments store source positions, a structural selector, tag and identifying
attributes, accessible/nearby text, a bounded source excerpt, enclosing context,
and a normalized click point. A pointer snapshot also records the actual element
under the pointer, its box, viewport/document coordinates, and the relative area
(such as “top-right corner”). Widening to a parent keeps the original pointer
hit, so agents can distinguish the selected section from the detail you pointed
at. This is context captured when commenting, rather than continuous pointer
tracking. Those technical details go to agents; the sidebar
uses labels such as **Button “Get started”** and **Page background**. References
follow unique identities and source-mapped elements across revisions. Missing or
ambiguous targets are explicitly marked unavailable; they never silently move
to an unrelated element. Outlines and pins sit above the preview so page styling
and clipped containers do not hide them.

Agent HTML proposals are reviewed as **one update**, replacing any still-pending
HTML proposal while retaining its original rejection text. This keeps Accept or
Reject from leaving half-applied markup. The proposed page renders immediately,
changed areas are outlined, and **Show code** expands the source diff. **Accept**
automatically writes the full HTML update to the file. Pending updates stay in BB.
**Reject** discards the proposal without writing it. No preview attributes, comments, or highlighting are written into the
saved HTML. Markdown retains its individual suggestions.

## What each button does

| Control | Behavior |
| --- | --- |
| **Track changes: On / Off** | Toggles personal edit tracking for this document. Agent proposals are always tracked. |
| **Accept** | Keeps this wording, dismisses/archives the suggestion, then moves to the next suggested edit. |
| **Accept all changes** | Accepts every pending suggestion in one file write and archives them; keeps comments open. |
| **Reject** | Restores the previous wording and dismisses/archives the suggestion, keeping your scroll position. |
| **Resolve / Reopen** | Dismisses a completed thread, or returns a resolved thread from History to the active sidebar. |
| **Delete** | After confirmation, permanently removes this thread, its replies, and archived copies without changing document text. |
| **Reply / Post reply** | Adds an instruction or response to that thread, reopening it when resolved. |
| **Post comment / Cancel** | Adds the anchored/document comment, or discards that unsent comment draft. |
| **Ask agent to revise** | Prepares a chat draft with the current review and comments. You choose when to send it. |
| **Cmd/Ctrl+S** | Flushes buffered review edits to BB. Does not accept suggestions or write pending text to the file. |
| **Hide review / Show review** | Hides or reopens the sidebar; starting a comment reopens it automatically. |
| **Clear history** | In History, permanently deletes this document’s archived changes, resolved threads, and recovery drafts. Keeps active comments, pending changes, and current text. |
| **History / Active review** | Switches the sidebar between dismissed/history items and live comments/suggestions. Click an entry to inspect it. |
| **Cmd+Enter / Ctrl+Enter** | Posts the comment or reply. Plain Enter adds a new line. |

Typing, comments, and decisions are stored automatically in BB. With tracking on,
your edits and all agent proposals stay out of the file until accepted. Each
**Accept** immediately writes that change to the file, excluding every remaining
pending suggestion. **Reject** restores its prior wording in the review without
writing to the file. With tracking off, your edits write automatically after
a short pause, including deletions across proposed and existing text. Editing a
suggestion retires it to History and commits your resulting wording. Unrelated
pending suggestions remain excluded. There is no Save
button or manual save state. If writing fails, the review retains the pending
suggestion so you can retry. Conditional writes protect outside edits. Comments
and review markup are never written into the source.

## Mid-review agent revisions

Within an explicitly requested review, agents can discover feedback without **Ask agent to revise**. The plugin
contributes an agent instruction and the `document_review_feedback` tool. CLI
equivalents:

```sh
bb document-review feedback --json
bb document-review feedback /absolute/path/document.html --json
```

The first discovers reviewed files in the invoking thread’s workspace. The
second returns unresolved threads, references, and the latest review revision.
Results are paged; follow `nextReviewOffset` / `nextCommentOffset` with `--offset`.
New agent sessions receive the updated instruction/tool configuration; an
already-running session can always use the CLI.

Agents revise the CURRENT editable content, not an initial snapshot. The plugin
diffs each submission against that content. Untouched pending suggestions keep
their IDs, overlapping suggestions update/combine, and completed decisions stay
in history. There is no need to finish a round before another agent pass.

```sh
bb document-review open /absolute/path/document.md --json
bb document-review get REVIEW_ID --json
# Write a complete revised draft based on the current `content`.
bb document-review propose REVIEW_ID --draft /absolute/path/draft.md --revision REVISION --json
bb document-review reply REVIEW_ID COMMENT_ID --body 'Explained the revision.' --revision NEXT_REVISION --json
```

Agents can start a comment or reply directly with `document_review_comment` and
`document_review_reply`. Author identity is taken from the calling thread. CLI
comments/replies are marked as agent messages:

```sh
bb document-review comment REVIEW_ID --body 'Check the button contrast.' --selector '#start-review' --revision REVISION --json
bb document-review comment REVIEW_ID --body 'Check this wording.' --start 10 --end 30 --quote 'exact current passage' --revision REVISION --json
```

Omit selector/offsets for a whole-document comment. HTML accepts a unique `#id`
or the structural selector from an existing element reference. A new comment
opens a new thread; a reply preserves the existing conversation.

The `document_review_propose` tool accepts `{ id, revision, content }`. It refuses a draft that silently withdraws pending personal edits. Intentional withdrawal requires `withdrawUserSuggestions: true` (CLI `--withdrawUserSuggestions`). Agents
return `::document-review{id="REVIEW_ID"}` to show a Review changes button.
Read [the agent skill](skills/document-review/SKILL.md) for details. For large
sessions, `content REVIEW_ID` returns only current Markdown, while `get REVIEW_ID
--comments --json` returns metadata/comments without duplicate document snapshots.

Concurrent typing and agent revisions merge automatically when they affect
different passages. If they overlap, the local draft stays visible and can be
downloaded before choosing the latest document. Revisions prevent silent
replacement of newer work.

Resolved threads are excluded from agent feedback and from `get` / `open` CLI
responses. They remain available in the user’s History, and are no longer revision
instructions. **Delete** asks for confirmation, then permanently removes a thread, replies, and all archived
copies without changing the document. Agents receive no delete tool.

## History, outside edits and cleanup

The plugin owns review history in SQLite. Accepted/rejected suggestions leave
the active sidebar with a brief fade and slide (respecting reduced motion).
**Clear history** in History permanently removes this document’s archived
changes, recovery snapshots, and resolved conversations. Active threads, current
text, and undecided suggestions remain. Finished reviews, archived changes/recovery
snapshots, and resolved comments are pruned after 14 days. Unfinished reviews
remain. Cleanup runs at startup, on opening/activation, and daily, and compacts
storage after pruning.

A confirmed moved/deleted file removes its obsolete review/history. Offline
hosts and temporary read failures are deferred. Outside file changes are merged
over the last saved file: unaffected local work remains, overlapping stale
suggestions are pruned, and irrelevant historical patches are removed. If an
outside edit conflicts with local text, History retains a downloadable prior
local draft for 14 days. Automatic file writes use hash comparison to prevent a disk-write race.

## HTML performance

The preview reuses parsed comment targets for each source version. HTML change
outlines use a cached diff with a short processing budget; very large rewrites may
show a broader changed region while retaining the exact proposed source. Scrolling
and selecting comments reuse target/range references and only render visible
highlights. Those references, observers, listeners, and animation frames are
released when the preview changes or closes; the diff cache uses weak keys.

Open reviews listen to their own document's updates. Focus refreshes that document
instead of scanning every review, and duplicate refreshes are coalesced without
missing a newer revision. Inventory cleanup from the home list is throttled;
explicit activation and scheduled cleanup still run normally.

## Markdown fidelity and limits

The editor supports headings, inline formatting, links, lists, task lists,
blockquotes, code, tables, and horizontal rules. Rich edits patch the original
source rather than regenerating whole blocks. Unchanged source stays byte-identical,
including relative/reference links, escapes, entities, whitespace, table padding,
and line endings. Cell edits preserve the original table delimiters and spacing.
Template/literal lines directly after a table stay outside its rows. Opening and
flushing an unedited document returns its exact original bytes. Frontmatter, raw HTML and unsupported
block constructs remain editable as literal text instead of being executed or
silently discarded. Images retain their source URLs and display as labels.

UTF-8 `.md`, `.markdown`, `.mdown`, `.txt`, `.text`, `.html`, `.htm`; up to 1 MB on open and
500,000 characters. Plain-text files stay literal. The CLI's 1 MB output limit
is separate from the document limit. Large/pathological diffs can fall back to
one replacement suggestion.

## Develop

```sh
npm install --include=dev
npm run typecheck
npm test
bb plugin build
bb plugin install .
# Later:
bb plugin build
bb plugin reload document-review
```

Requires BB Plugin SDK 0.6.49 or later. The plugin is installed from this
directory; retain it while enabled, or install a new path before moving it.
