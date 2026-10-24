# A better writing workflow

Good documents start with a rough draft. This workflow helps you improve it with an agent while keeping control of every edit.

## How it works

1. Open a Markdown file and select a passage.
2. Leave a comment describing the change you want.
3. Ask an agent for a revised draft.
4. Accept or reject each suggested change, then save.

The original file stays untouched while you review. Comments stay in the review session, so the saved document remains clean Markdown.

> You have the final word on every change.

## A few details

| Feature | Why it matters |
| --- | --- |
| Inline revisions | Read edits in context |
| Comments | Give specific direction |
| Selective approval | Keep the edits you like |

An agent can change **the wording**, preserve [existing links](https://getbb.app), and leave code alone:

```sh
bb document-review open document.md --json
```
