Run bb's Claude Code threads on the Claude accounts you already connected in Liminal Tools,
with the same names and the same rules for choosing and switching accounts.

## What you get

- Threads start on the account Liminal would pick and move to another account when one runs
  out, continuing the same conversation.
- A **Mana Bar** in the sidebar footer and on this plugin's settings page: weekly allowance
  left per account, counting down, with an even-pace tick and the time to reset.
- An **account picker** in the composer, next to the provider and model: switch a thread's Claude
  account from its next turn, or pick the account a new thread starts on (Automatic leaves it to
  Liminal). For Codex it shows the login bb uses, this Mac's own.
- `bb liminal-pool status`, `thread` and `switch` commands.

## How it works

Each Liminal account is a Claude Code home signed in by Liminal. The plugin points a thread's
Claude Code at that home, so Claude Code itself keeps each login fresh and no token is copied
or proxied. Liminal's files are read, never written.
