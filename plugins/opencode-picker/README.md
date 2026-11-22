# OpenCode Picker

Enhances the OpenCode (`acp-opencode`) model picker in [bb](https://getbb.app):

- **Pinned Recent section**: Keeps your 4 most recently used OpenCode models (configurable, 1–10) at the top of the OpenCode model list under **Recent**, sourced from actual OpenCode turns (`opencode.db` and `acp-opencode` BB threads — never picker clicks or other providers).
- **Relative cost badges**: Shows compact `Free`, `$`, `$$`, `$$$`, or `$$$$` badges directly from OpenCode's official model APIs (`opencode.ai/inference/v1/models` for Zen per-token pricing and `opencode.ai/inference/go/v1/models` for Go monthly allowance burn rate), with exact rates and Go allowance caps on hover.
- **Go plan models only**: Lists only models offered on the OpenCode Go plan, taken from OpenCode's live Go catalog (`opencode.ai/inference/go/v1/models`). Zen pay-per-token and Claude/OpenAI routes are hidden, and models OpenCode rotates out of Go drop out automatically (configurable in settings; the full list is shown if the catalog cannot be fetched).
- **Strength + cost weighted sorting**: Sorts the listed models by a combined weight (68% relative benchmark strength, 32% cost efficiency with steeper penalties on `$$$`/`$$$$`) so strong, cost-effective models float to the top.
- **Relative 1–5 strength bars**: Displays a compact 5-bar signal meter next to each OpenCode model using cached [Artificial Analysis](https://artificialanalysis.ai/) Intelligence Index v5 scores (green on 5/4, yellow/amber on 3/2, red on 1, with distinct shade variation per tier). Hover any meter for the exact cached index score.

## Data sources

- **Benchmarks**: Fetched and cached server-side (default 6h TTL, stale-while-error fallback) from the free daily Artificial Analysis Intelligence Index mirror (`terryds/bestvaluemodel`). You can optionally configure a free Artificial Analysis API key in **Settings → Plugins → OpenCode Picker** to query `artificialanalysis.ai` directly.
- **Pricing**: Fetched and cached server-side directly from OpenCode (`https://opencode.ai/inference/v1/models` and `https://opencode.ai/inference/go/v1/models`). The Go catalog doubles as the picker's model list when **Go plan models only** is on.
