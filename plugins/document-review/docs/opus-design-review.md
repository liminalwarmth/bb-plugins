# Document Review — design review (Opus 5.5, read-only)

Scope read: `app.tsx`, `RichDocument.tsx`, `styles.css`, `editor-extensions.ts`, `model.ts` (anchors/reviewPrompt), `contract.ts`, `server.ts` (file I/O), SDK `FilesArea`.

## Verdict on the proposed interpretation

**Mostly right. Six corrections:**

1. **Show the user what they're commenting on, not what an "element" is.** For a non-technical user, the important parts are (a) an outline around the target while the menu and draft are open, (b) a plain-language label ("Button 'Start free trial'", "Image", "Pricing section", "Area in Pricing section"), and (c) a one-click way to widen the scope (breadcrumb chips: `Button › Card › Pricing section`). Selectors, tags and offsets go to the agent and never to the UI.
2. **When the user right-clicks text with nothing selected, target the enclosing block (paragraph, heading, list item, table cell), not the word.** Right-clicking a sentence usually means "this paragraph". A user who wants a word can select it first: a right-click inside an existing selection always uses the selection.
3. **Don't take over right-click completely in the Markdown editor.** That kills spellcheck suggestions and cut/copy/paste. Show the custom menu, and if the user right-clicks again while it's open (or Shift+right-clicks), pass through to the native menu. A "Copy" item would also help.
4. **"Scripts off" breaks a large share of real design samples.** Agent-written mockups often use `<script src="https://cdn.tailwindcss.com">`, Alpine, chart libraries and similar. Those pages render unstyled or empty. Ship with an honest notice when the source contains `<script>`, and design now for a later opt-in "interactive preview" (see Defer).
5. **Agent proposals on HTML: accepting raw-source hunks one at a time can't be read by this user and can leave broken markup halfway through.** Ship HTML as comments-first. Proposals still arrive as tracked source changes, but the preview renders the proposed result with changed elements outlined, and each sidebar card names the affected element ("Changed: Pricing section"). Collapse the source diff behind a "Show code" toggle.
6. **Deselecting has to work inside the HTML iframe too.** Clicks, Escape and right-clicks inside the iframe don't bubble to the parent, so every interaction listener must be attached to the iframe's document.

Everything else (durable conversations about rendered content, a context menu with "Comment here", the draft placed among its neighbours and focused, a sandboxed read-only HTML preview, a structural plus textual locator, conservative re-anchoring with explicit orphan states, nothing written into saved files, assets loaded through a scoped host API, text editing deferred) is correct.

---

## P0 — bugs to fix now (diagnosed in code)

### 1. Resolving a comment leaves the red outline
- `app.tsx:150`: `resolve` calls `commentStatus` but never clears `active`.
- `RichDocument.tsx:57` still decorates resolved comments **when focused**: `if ((c.status === 'resolved' && !focused) || !c.anchor) continue;`. A comment that was focused when it was resolved stays outlined.
- **Fix:** after a successful resolve, `if (active === c.id) setActive('')`. Draw resolved anchors only while History is showing: pass `showHistory` (or filter `comments` before passing them) so the `focused` exception applies only in History. Do **not** auto-advance to the next comment as Accept does. The user asked for the outline to go away, not move.

### 2. Clicking anywhere in the document should deselect
- `RichDocument.tsx:71` `handleClick` only calls `onPick` when the click lands on a `[data-review-item]`. All other clicks are ignored.
- **Fix:** add a separate `onClear()` prop. Don't use `onPick('')`, because `locate()` also changes `showHistory`, and a click in the document shouldn't close History.
  - Inside the editor: clicking a review item picks it, otherwise call `onClear()`.
  - Outside the editor: on `.dr-document-scroll` (the grey margin and paper padding), call `onClear()` on mousedown when the target isn't inside `.ProseMirror` or `.dr-floating`.
  - Escape anywhere in `.dr-root` (when no menu or form is open) calls `onClear()`.
  - Clicking empty space in the sidebar (not a card) calls `onClear()`.
  - For HTML: do the same through the iframe document's `click` and `keydown` listeners.
- Clicking the active card's heading again could toggle it off. This is optional.

### 3. The link control is broken
**Root cause (high confidence):** clicking **Link** sets `link` state, and the `autoFocus` input takes focus. The editor then blurs. Tiptap's FocusEvents dispatches a blur **transaction**, and `editor.on('transaction', update)` runs `update()`. That sees `!editor.isFocused` and calls `setBar(null)` (`RichDocument.tsx:108,119`). The bar unmounts and the link form disappears with it. The 50 ms `blur` guard doesn't help because `update` ran first. Any decoration refresh (`RichDocument.tsx:102`) while the input has focus does the same.

**Fix:**
- Move link editing out of `FormatBar` into `RichDocument` state: `linkEdit: { from, to, href } | null`, capturing the ProseMirror positions when the user clicks Link. While `linkEdit` is set, `update()` must not clear the bar. More generally, never clear it while `document.activeElement` is inside `.dr-floating`.
- To apply: `editor.chain().focus().setTextSelection({from,to}).extendMarkRange('link').setLink({href}).run()`. To remove: `unsetLink()` the same way.
- Accept bare domains: `example.com` becomes `https://example.com`. When a value is rejected, show an inline error. Today an invalid value submits and nothing happens.
- Enter applies. Escape cancels and returns focus to the editor.
- Cmd/Ctrl+K opens the link editor.
- When the cursor sits in an existing link with no selection, `selection()` returns null, so no bar appears and the user can't edit or remove the link. Show a small link popover instead: `Open ↗ · Edit · Remove`. Open goes through BB navigation, because `openOnClick: false`.
- Test: open the link form, fire editor blur and a decoration transaction, and assert the form is still mounted and applying it changes the Markdown.

### 4. New comment draft appears at the top
- `app.tsx:146`: the draft `<form>` is rendered before `flow`.
- **Fix:** make the draft an item in `flow` (`type: 'draft'`, `position: anchor?.start`). With an equal position, sort it **after** existing items. Unanchored drafts must sort exactly where a posted unanchored comment will land. Today that's `MAX_SAFE_INTEGER`, the end. Either move both to the top under a "Whole document" label (recommended) or keep both at the end. Either way the card must not jump when it's posted.
- After mounting it, `scrollIntoView({block:'nearest'})` and focus the textarea. This already happens.
- **Missing polish:** the document selection disappears as soon as focus moves to the textarea, so the user can no longer see what they're commenting on. Add a draft decoration (dashed amber, not the red "focused" style) for `anchor` while `writing` is true. Pass `draftAnchor` into `RichDocument`. For HTML, use an overlay outline.
- Cancel and Escape remove the draft and its highlight. Posting turns the draft into the real card in the same place, and the card becomes active.

---

## P1 — right-click to comment (ship now)

### Shared interaction
- **Trigger:** `contextmenu` on the document surface (the Tiptap DOM, or the iframe document for HTML). Keyboard: the ContextMenu key or Shift+F10 on the focused editor.
- **When the menu opens:** draw an outline around the resolved target right away, so the user sees what "here" means.
- **Menu:** `role="menu"`, with focus on the first item. Arrow keys, Escape and clicking outside close it. Clamp it to the viewport.
  - `Comment on <label>` (primary)
  - `Copy`, in Markdown when there's a selection
  - With the Shift/second right-click pass-through, that's enough. Don't add more items.
- **Choosing Comment:** opens the draft in place in the sidebar (P0 #4). The draft header shows the label and the breadcrumb chips (`Paragraph › List › Section "Pricing"`). Clicking a chip changes the target and moves the outline.
- **Discoverability:** in HTML mode, "+ Comment" in the toolbar enters **pick mode** (crosshair cursor, hover outline, click to choose, Esc to cancel). Change the empty-state text to "Right-click anything to comment."

### Markdown targets
| Right-click on | Target |
|---|---|
| Inside the current non-empty selection | The selection (existing text anchor) |
| Text, no selection | The enclosing textblock: paragraph, heading, list item, table cell |
| Image (`MarkdownImage` atom), `hr`, code block, raw block | That node |
| Blank paper area | The nearest block by `posAtCoords`, or "Whole document" below the last block |

- Use `view.posAtCoords` and then walk `$pos` up to the target node. Take `[nodeStart, nodeEnd]` and convert with `positionToSource` into the existing `Anchor` (`makeAnchor`). That keeps the anchor model unchanged.
- Atom and block nodes need `Decoration.node(...)` for the outline. The inline decoration that `RichDocument.tsx:60` uses today doesn't draw on atoms.
- Add a `target.kind` (`'text' | 'block' | 'image' | …`) and a human label, so the sidebar quote can say "Image: diagram.png" instead of showing raw `![…](…)`.

### HTML (read-only preview)
**Rendering**
- Add a `format: 'markdown' | 'text' | 'html'` to the session, derived from the file extension. Don't infer it from `plain`. Add `html` and `htm` to the `fileOpener` extensions.
- Render in `<iframe sandbox="allow-same-origin" srcdoc=…>` with **no `allow-scripts`**. Never combine `allow-scripts` with `allow-same-origin`. Same-origin without scripts lets the parent attach listeners and read `getBoundingClientRect`, while the page's own scripts can't run. Also set `allow=""` to disable feature permissions, and set `referrerpolicy="no-referrer"`.
- Build the `srcdoc` from a **copy** of the source:
  - Inject `<base href="{previewBaseUrl}">` from `bb.sdk.files.createPreview({ hostId, rootPath })`. It returns `{ baseUrl, expiresAtMs }`, which is the scoped host file API. Refresh it before it expires. Use the workspace or environment root as `rootPath` when known so `../assets` resolves; otherwise use the document's directory. Drop any authored `<base>`.
  - Inject a CSP `<meta>`: `default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; img-src {base} data: blob: https:; style-src {base} 'unsafe-inline' https:; font-src {base} data: https:; media-src {base} data:`. The decision for the parent: allowing `https:` images, styles and fonts makes Google Fonts and Unsplash-style mockups look right, at the cost of possible tracking pixels. I recommend allowing them.
  - Strip `<meta http-equiv="refresh">`.
  - Inject `data-dr-node="N"` into every start tag, as described under "Mapping".
- Intercept `click` on links and buttons inside the iframe with `preventDefault`. In the preview, a click selects or deselects; it never navigates.
- Layout: render HTML full-bleed in the document pane, not inside `.dr-paper` (max-width 830 would break desktop designs). Use a white canvas with no dark-mode theming of the authored page. The iframe fills the pane and scrolls internally. Don't auto-size it to the content height, because `100vh` heroes cause a feedback loop.
- Re-render `srcdoc` only when `content` changes, debounced. Restore scroll by remembering the topmost visible `data-dr-node` and its offset. A plain `scrollTop` isn't enough.
- Show a notice when the source contains `<script>`: "Interactive scripts are off in review. Some parts of this page may look different from the live version."

**Mapping clicks to source (the key technical choice)**
- Parse the source with **parse5** (`sourceCodeLocationInfo: true`). It's spec-compliant, so its tree matches the browser DOM. Give each element an index N, and record `{start, end, startTagEnd, tag, attrs}`.
- Build the srcdoc by inserting ` data-dr-node="N"` textually right after each start tag's name, using the offsets. Everything else stays byte-identical. The saved file is never touched.
- A right-click target becomes `closest('[data-dr-node]')` after applying the "meaningful element" heuristic, and N gives exact source offsets. Agents get precise ranges, and re-anchoring works on source.

**Choosing the target (the "infer intent" part)**
Walk up from the event target to the first meaningful element:
- interactive: `a`, `button`, `input`, `select`, `textarea`, `[role=button|link|tab|menuitem]`
- media: `img`, `svg` (outermost), `video`, `canvas`, `picture`, `figure`
- text block: `h1`–`h6`, `p`, `li`, `td`, `th`, `blockquote`, `label`
- landmark: `section`, `article`, `header`, `footer`, `nav`, `aside`, `main`, `form`, or anything with an `id`, a `role`, or `aria-label`
- a "card-like" box: has its own background, border or box-shadow and is smaller than the viewport

Skip inline wrappers (`span`, `strong`, `em`, `i` used as icons) and stop at `body`. If the click lands on a container's padding or gap rather than a child, the target is that container with kind `region`, and the normalized click point is recorded for a pin.

Labels: role or tag in plain words, plus the accessible name or trimmed text, plus the nearest landmark. Examples: `Button "Start free trial"`, `Image "Team photo"`, `Heading "Pricing"`, `Area in Section "Pricing"`.

**Showing targets**
- Draw outlines and pins in a **parent overlay layer** positioned from the iframe element's rect plus the iframe offset, updated on iframe scroll and resize. Don't style the iframe DOM: an outline inside `overflow:hidden` gets clipped, and authored CSS can override it.
- Styles: active comment in red (matching Markdown), draft in dashed amber, menu target in dashed. Region comments get a small numbered pin at the stored point.
- Order sidebar cards by source start offset. That's stable and almost always visual order. Note that CSS `order` and absolute positioning can differ, which is acceptable.

### Saved reference (for agents)
Extend the anchor with an optional `target`:
```ts
target?: {
  kind: 'text' | 'block' | 'element' | 'region';
  label: string;                         // human: Button "Start free trial"
  sourceRange: { start: number; end: number; startTagEnd?: number; line: number; column: number };
  tag?: string; id?: string; role?: string; accessibleName?: string;
  selector: string;                      // e.g. section#pricing > div.card:nth-of-type(2) > button
  ancestors: string[];                   // ['Card "Pro"', 'Section "Pricing"'] human-readable
  text?: string;                         // visible text, ≤ 300 chars
  excerpt: string;                       // outerHTML, ≤ 2 KB, truncated with marker
  point?: { x: number; y: number };      // 0–1 within the element box (region/image)
  viewportWidth?: number;
}
```
- Keep `quote` small: use the **start tag** for HTML, with the existing prefix and suffix. Don't store a 20 KB outerHTML.
- Never persist `data-dr-node` numbers. They change between revisions.
- In `reviewPrompt` and `get --json`, show each comment as: `On Button "Start free trial" (index.html line 120, section#pricing > .card:nth-of-type(2) > button): <body>`. Tell agents to edit the source at that range and to keep everything else byte-for-byte.

### Re-anchoring after agent revisions (conservative)
Re-parse with parse5, then try in order and stop at the first **unique** match:
1. `id` (if it was unique before and is unique now)
2. Start-tag quote with prefix and suffix (the existing `reanchor`). Then recompute `end` from parse5.
3. Selector plus a text fingerprint (`tag` + `accessibleName`/`text` exact)

- If a match is found but its text or excerpt differs, keep the anchor and mark it `changed: true`. It's still the same thing.
- If there's no match or more than one, set `orphaned: true`. The sidebar shows "Couldn't find Button 'Start free trial' in this version" with the saved excerpt, and nothing is highlighted in the preview. Never fall back to the click point or a nearby element.
- The click point is only used for display.

---

## Ship now vs defer

**Ship now**
1. The P0 fixes: resolve, deselect, link, draft placement, and the draft target highlight.
2. The right-click menu in Markdown (selection, block or node), with native pass-through.
3. A read-only HTML preview: sandboxed srcdoc, CSP, assets through `createPreview`, the parse5 node map, a right-click menu with smart targeting and breadcrumb widening, pick mode, overlay outlines and pins, the `target` schema, re-anchoring and orphan states, agent prompt and `get` output, and the scripts notice.
4. HTML proposals as tracked source changes, with an element-named card, a collapsible code diff, and a changed-element outline in the preview.

**Defer**
- **HTML text editing.** The design is fidelity-safe for a later version: allow "Edit text" only on elements whose children are a single text node. Replace exactly that text node's parse5 source range with the entity-escaped new text. For anything else, offer "Comment instead".
- **Interactive preview** (opt-in per document): `sandbox="allow-scripts"` **without** `allow-same-origin`, plus a small injected bridge script that postMessages target descriptors. Treat those messages as untrusted and validate them against the source offsets. Write the target-descriptor function as a pure DOM function now so the bridge can reuse it.
- Device-width presets and a responsive preview.
- Rendered before/after compare for HTML proposals; per-change visual diffs.
- Comment-on-hover affordances and multi-element selection.

## Pitfalls checklist
- Iframe events don't bubble to the parent: attach click, contextmenu, keydown and scroll listeners to `iframe.contentDocument` after every `load`, because srcdoc reloads replace the document.
- `contextmenu` coordinates inside the iframe are relative to the iframe; add `iframe.getBoundingClientRect()` before positioning the menu in the parent.
- When the iframe has focus it swallows keyboard shortcuts (Cmd+S, Escape). Forward them from the iframe document.
- The `createPreview` URL expires; refresh it before `expiresAtMs`, or images go blank.
- Never write the srcdoc, injected attributes, CSP or `<base>` back. Saved files must stay exactly as the source and agent revisions left them. Add a test that saves an HTML session and compares it byte-for-byte.
- Verify in the real BB webview (not only jsdom) that listeners registered by the parent fire in a `sandbox="allow-same-origin"` srcdoc without scripts, and that `<base>` assets load from the preview URL.
- `locate('')` changes History state. Keep "clear selection" separate from `locate()`.
- The bundle grows by parse5 (around 45 KB gzipped). That's acceptable. Alternatively, return the node map from the server in `get`.
- Accessibility: menu roles and focus, keyboard pick mode, and `aria-live` when the draft opens.


## Implementation decisions after discussion

Opus confirmed a single atomic HTML Accept/Reject satisfies the comments-first intent and protects markup integrity. HTML text editing and interactive scripts are deferred. Save retains the user's requested semantics: current content including pending proposals, without accepting them; the HTML preview states this explicitly. Scoped asset loading uses the plugin's validated host asset route.
