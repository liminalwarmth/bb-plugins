# bb-plugins

My plugins for [bb](https://getbb.app). Each plugin lives in its own folder under `plugins/`
with its own `package.json`, and `.bb/plugins.json` lists them.

| Plugin | What it does |
| --- | --- |
| [document-review](plugins/document-review) | Reviews Markdown and HTML with formatting, comments, tracked personal and agent suggestions, and document history. |
| [liminal-pool](plugins/liminal-pool) | Runs Claude Code threads on Liminal Tools' Claude accounts, with Liminal's selection and failover, a Mana Bar, and an account picker in the composer. |
| [opencode-picker](plugins/opencode-picker) | Pins your 4 most recently used OpenCode models under Recent, shows compact relative cost badges (`Free`, `$`–`$$$$`), and displays relative 1–5 Artificial Analysis strength bars in the model picker. |

## Working on a plugin

```sh
cd plugins/<name>
npm install --include=dev
bb plugin build
bb plugin install .        # path install: bb loads it from this folder
bb plugin reload <name>    # after later builds
```

## Adding a plugin

```sh
cd plugins && bb plugin new <name>
mv bb-plugin-<name> <name>
```

Then add `{ "name": "<name>", "source": "./plugins/<name>" }` to `.bb/plugins.json` and a row
to the table above.

## Installing from GitHub instead

```sh
bb plugin install git:https://github.com/liminalwarmth/bb-plugins.git@main --plugin <name>
```
