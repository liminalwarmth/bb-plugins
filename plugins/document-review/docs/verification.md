# Document Review 0.7.1 verification

Verified 2026-10-17 on the installed BB plugin, using disposable Markdown and HTML files. Existing user reviews were preserved.

## Persistence

The source file always equals committed review content: the current working copy with every pending suggestion reverted. Accept immediately writes only the chosen suggestion. Reject and comment actions do not write the source. Untracked personal edits write automatically, including mixed proposed/original selections; suggestions the user edits are retired to History while unrelated suggestions stay pending. Agent proposals are always pending.

Conditional file writes and a committed-content baseline guard prevent overwriting outside edits. Outside edits rebase unaffected suggestions in committed coordinates and archive conflicting pending work with a recovery snapshot. Invalid state falls back conservatively without writing the source.

## Verification matrix

| Flow | Markdown | HTML |
| --- | --- | --- |
| Right-click → Comment here; target draft focused | Passed, paragraph and list-item scopes | Passed, button and parent section scopes |
| Native text selection → anchored comment | Passed, complete visible selection | Passed, selected rendered text |
| Cmd/Ctrl+Enter posts; Enter adds newline | Passed | Passed |
| Clicking comment highlight selects and scrolls to thread | Passed, including hidden sidebar | Passed, including hidden sidebar |
| Click outside / Escape deselects | Passed | Passed inside iframe |
| Resolve removes highlight; History reply reopens | Passed | Passed |
| Delete removes thread and target decoration | Passed | Passed |
| Clear history retains active work | Backend regression coverage | Live verification |
| Pending proposal leaves source unchanged | Passed | Passed |
| Accept writes only accepted work | Passed, other proposal excluded | Passed, atomic HTML proposal |
| Reject leaves source unchanged | Passed | Passed |
| Tracked typing stays pending | Passed | Static preview; editing deferred |
| Untracked typing writes committed content | Passed, pending text excluded | Static preview |
| Link selection survives URL-field focus | Passed | Preview links do not navigate |
| Existing link Edit / Remove and Cmd/Ctrl+K | Regression coverage; native Edit verified | Not applicable |
| Pointer hit, corner, and wider scope retained | Block target geometry | Passed, original button hit retained with section scope |
| Asset root / symlink confinement | Not applicable | Outside-root symlink returned 404 |

Delete has an inline confirmation and permanently removes archived copies of the thread. SQLite secure deletion is enabled and the write-ahead log is checkpointed after deletion. Resolved comments are excluded from agent feedback and CLI document reads; only the user’s History retains them until reopened or deleted.

## Automated and independent review

- TypeScript: `npm run typecheck`.
- Regression suite: `npm test` (110 tests across 7 files).
- Seeded regression exercises 300 mixed real backend operations, checking source versus committed text after every operation.
- Opus 5.5 independently reviewed the code and rechecked all four data-loss fixes: 24,000 randomized state sequences without an invariant violation, 150 sessions of backend operations, 4,000 recovery cases, and 2,000 realistic typing sessions.
- Opus’s final focused pass found no blocker. Its deletion-confirmation recommendation and stale HTML draft identity edge case were fixed afterward, with regression coverage. The reviewer’s full report is at `/private/tmp/document-review-opus-production-review.md`.

## Scope and remaining decisions

PDF commenting is deferred: it needs a separate rendered-page/text layer, page-space anchors, and document-version handling. HTML remains a static preview with script execution disabled.

The original explicit policy still prunes reviews when a file is confirmed missing. A recommendation to retain those reviews read-only for 14 days remains awaiting the user’s choice; temporary renames or branch switches can otherwise remove pending work. Offline hosts and temporary read failures are deferred.

Recovered old unsaved reviews may be combined into a single pending suggestion. Granular recovery remains a follow-up. The former rule that tracked mixed untracked edits has been removed in 0.8.1 at the user’s request.

## 0.7.1 bulk acceptance and opt-in instructions

Accept all changes is available in the active sidebar header. Live verification
accepted three Markdown suggestions and wrote the exact proposed source; the
button then disabled. Backend regression coverage accepts over 100 mixed user
and agent suggestions in one conditional write, preserves open/resolved comments
and complete History patches, and checks stale revisions, disk conflicts, and
offline failures. UI coverage verifies buffered typing is flushed first.

The skill trigger, its body, agent tool descriptions, README, and globally injected
agent instructions now restrict review to explicit proposed/tracked changes to an
existing Markdown file, or explicit Document Review invocation. Routine Markdown
creation, plan rewrites, and updates to agent-produced documents are excluded.
The instructions were checked with positive and near-miss examples; no additional
independent agent review was run for this small follow-up.

## 0.8.0 — interactive HTML and complete Markdown source editing

- TypeScript: `npm run typecheck` passed. Regression suite: 125/125 tests across 8 files.
- Built with `bb plugin build`; installed `document-review` reload reports 0.8.0 running.
- The actual Battle Brothers explainer (`review_129da33f-e55`) filters from 10 classes to 4 when Tank is selected. Its review remains revision 8 with both original comments intact; no source writes or review decisions were made.
- Disposable HTML: native details expand, scripted buttons update, print handler runs, and attempted parent DOM access is blocked by the opaque sandbox. Right-click opens contextual commenting; Cmd+Enter posts; clicking the commented element reopens the hidden sidebar and focuses its card. Native drag selection followed by Cmd+Alt+M targets exactly “Select these words”.
- Disposable Markdown: Select row + native Backspace removes the complete row from the rich table. Raw shows the resulting source; the file still contains the row while tracking is enabled. Automated coverage also checks normal text selection across a row, Delete, rejection, switching views before the typing debounce, exact raw source, and Accept all persistence.
- Static HTML remains available with Interaction: Off. The interactive iframe receives no BB APIs, source write commands, comment bodies or history. Incoming messages require its WindowProxy, opaque origin, current document channel, bounded schemas and source-backed target IDs. Preview scripts and metadata never enter the saved source.
- Added JavaScript preview asset MIME/CORS coverage alongside existing path-confinement tests. No API connections, form submits, popups, embedded frames or top-level BB navigation are permitted by the preview policy.
- Removed disposable files/reviews and closed the owned browser session after verification.

## 0.8.1 — one view toggle and direct edits with tracking off

At the user’s request, tracking off now treats edits to suggestions as direct author decisions. Suggestions actually edited are retired to History and the resulting wording is written automatically. Unrelated suggestions retain their IDs and remain excluded from the file. Toggling tracking off alone still changes no suggestion. This intentionally replaces the earlier conservative rule that turned mixed edits back into tracked suggestions.

- One **View: Rich / View: Raw** button switches modes and retains buffered edits.
- TypeScript check passed; 133/133 tests passed across 8 files. Coverage includes mixed native/proposed deletion and replacement, partial edits to proposed words, untouched suggestions, comment preservation, reload persistence, and typing beside a pending deletion without creating an invalid range.
- Live BB, disposable document: native Backspace across proposed and original text in Raw immediately wrote `Hello .` while the second proposal remained pending with its original ID and its committed wording remained on disk. Switching the same button back to Rich and using native Backspace across the second proposal and original wording immediately wrote `Keep .`, with no new pending edits. Both edited suggestions were available in History.
- Built/reloaded installed plugin 0.8.1; no real review document or comment was modified. Disposable review/files removed and owned browser session closed after verification.

## 0.8.2 — source-preserving Markdown round trips

The Markdown adapter now patches original source instead of re-serializing changed blocks. Bare relative and anchor destinations remain intact. Existing inline syntax (including reference links, nested delimiters, entities, escapes and whitespace) is reused, and table edits retain original cell padding and delimiter spellings. Pipe-less template/literal continuation lines are protected from GFM table-row normalization. The rich editor no longer inserts a trailing paragraph automatically.

- `npm run typecheck` passed. Permanent regression suite: 174/174 tests across 9 files.
- Six committed fixtures cover relative/reference/anchor links, literal trailing space and escapes/entities, compact tables, Mustache lines immediately after a table, another literal template line, and CRLF source. Every fixture has byte-identical no-edit and nearby-edit assertions. Editor-level tests verify load/checkpoint makes no edit RPC and a nearby untracked edit writes only the intended bytes.
- Additional tests cover label/cell edits, formatting beside unchanged nested markup/reference links, row/column deletion without padding normalization, compact star lists, tilde fences, empty documents/cells, and paused typing after a literal leading/trailing space. Live-editor whitespace is retained in the source map so a later keystroke cannot move or duplicate it.
- Separate read-only probes passed on 28 current liminal-tools files: AGENTS.md, README.md, CONTRIBUTING.md, plugins/development/assistant/bundled/guide.md and 24 SKILL.md files. No-edit output was exact, and a nearby prose edit changed only its source span. The scratch corpus test was removed after use; no source in that repository was written.
- Live installed BB: opening/checkpointing a disposable document retained its SHA. Native typing changed one prose word, typed a space and resumed after a pause, and changed one compact-table cell. The final disk file matched exactly those substitutions; relative destinations, table separators and the Mustache block were unchanged, and no space entity was introduced.
- Built/reloaded Document Review 0.8.2. Removed disposable review/files and closed the owned browser session.
