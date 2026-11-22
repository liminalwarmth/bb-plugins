# Hotfixes (`bb-plugin-hotfixes`)

Lightweight container for local workarounds to BB bugs while waiting on upstream releases. Each hotfix lives in `fixes/`, has a boolean toggle in **Settings → Plugins → Hotfixes**, and can be deleted once fixed upstream.

## Active hotfixes

| ID | What it fixes | Upstream |
| --- | --- | --- |
| `browserNoDrag` | Overrides page CSS `-webkit-app-region: drag` / `app-region: drag` with `no-drag !important` so Electron-targeted sites like Linear don't turn issue panes into BB window drag handles. | [get-bb/bb#5862](https://github.com/get-bb/bb/issues/5862) |
| `browserPointerFocus` | Ensures clicking inside an unfocused desktop Browser tab transfers native keyboard focus to the page. | [get-bb/bb#8030](https://github.com/get-bb/bb/issues/8030) |

## Build & install

```sh
bb plugin build
bb plugin install .
bb plugin reload hotfixes
```
