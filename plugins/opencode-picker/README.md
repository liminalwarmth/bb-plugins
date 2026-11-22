# OpenCode Picker

Enhances the OpenCode (`acp-opencode`) model picker in [bb](https://getbb.app):

- **Pinned Recent section**: Keeps your 4 most recently used OpenCode models (configurable, 1–10) at the top of the OpenCode model list under **Recent**, sourced from actual OpenCode turns (`opencode.db` and `acp-opencode` BB threads — never picker clicks or other providers).
- **Relative cost badges**: Shows compact `Free`, `$`, `$$`, `$$$`, or `$$$$` badges from [models.dev](https://models.dev/) (route-provider-aware blended $/1M tokens), with exact input/output rates on hover.
- **Relative 1–5 strength bars**: Displays a compact 5-bar signal meter next to each OpenCode model using cached [Artificial Analysis](https://artificialanalysis.ai/) Intelligence Index v5 scores (green on 5/4, yellow/amber on 3/2, red on 1, with distinct shade variation per tier). Hover any meter for the exact cached index score.

## Data sources

- **Benchmarks**: Fetched and cached server-side (default 6h TTL, stale-while-error fallback) from the free daily Artificial Analysis Intelligence Index mirror (`terryds/bestvaluemodel`). You can optionally configure a free Artificial Analysis API key in **Settings → Plugins → OpenCode Picker** to query `artificialanalysis.ai` directly.
- **Pricing**: Fetched and cached server-side from `https://models.dev/api.json`.
