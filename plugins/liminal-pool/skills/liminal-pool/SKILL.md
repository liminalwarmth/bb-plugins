---
name: liminal-pool
description: "Inspect which Liminal Tools Claude account a bb thread runs on, read each account's allowance left (Mana Bar), move a thread to a named account, or choose a Liminal Codex login for a BB thread."
---

# Liminal Pool

bb's Claude Code threads run on Liminal Tools' Claude accounts, named as Liminal names them
(for example `CLAW-5x`, `CLEX-20x`). Each account is a Claude Code home that Liminal signed in;
the plugin sets `CLAUDE_CONFIG_DIR` to that home for the thread's turns. It reads Liminal's
records and never writes them; sign-ins, renames, Connections switches and worker pins are
changed in Liminal Tools.

```sh
bb liminal-pool status [--refresh] [--json]   # Mana Bar: weekly allowance LEFT, reset countdown
bb liminal-pool thread [<thread-id>] [--json] # the thread's account, exhaustion markers, and any wait
bb liminal-pool switch <label-or-id> [--thread <thread-id>]  # from the thread's next turn
bb liminal-pool codex [<label-or-id>] [--thread <thread-id>] [--json]  # show or choose a BB thread's Codex login
```

Allowance is always reported as what is left, counting down to the reset, never as usage.
Antigravity reads quota through the local Antigravity CLI's `/usage` command using its existing login.
The row shows the shared Gemini quota. Hover to see the separate Argon weekly quota when reported.

Policy (Liminal's own):

- New threads start on the eligible account whose weekly window resets soonest; accounts with a
  spent weekly or five-hour window go last. Liminal's worker pin for Claude wins until that
  account is at zero. Eligible means listed in Liminal, not switched off in Connections, no
  failed Keychain move, and signed in.
- A thread keeps its account. On a usage limit, the account is marked exhausted until its reset
  and the thread moves to the first account in Liminal's order with a fresh reading showing room
  in every relevant window and the same model and effort in its catalog. The thread then
  continues with Liminal's fallback prompt on the same native session.
- With no such account, the thread resumes one minute after the soonest reset. Sonnet threads
  wait rather than move, because their thinking is bound to the account.
- Other rate limits resume after 30 seconds, 2 minutes, then 10 minutes. Provider Retry is told
  not to retry rate limits for these threads; it still retries overloads.

The composer's account picker does the same as `switch` for an open thread. In the New Thread
composer it remembers one pick for the next Claude Code thread the user starts (its first message
within two minutes of creation); Automatic clears it.

The Codex picker applies to a BB thread on this Mac from its next turn. In the New Thread
composer it selects the account for the next Codex thread. Automatic uses the primary login.
Secondary logins stay in their Liminal account homes. Sign in to added accounts from Liminal Tools.

Do not switch a thread's account or change plugin settings unless the user asks.
