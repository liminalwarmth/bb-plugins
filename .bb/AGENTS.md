This repository holds my bb plugins, one per folder under `plugins/`, indexed in `.bb/plugins.json`.

- New plugin: `cd plugins && bb plugin new <name> && mv bb-plugin-<name> <name>`, then add an entry to
  `.bb/plugins.json` and a row to the README table. Remove the plugin's own `.gitignore` (the root one covers
  `dist/` and `node_modules/`).
- `bb plugin new` and `npx shadcn add` treat a plugin's `src/` folder as the component root. Vendored UI belongs
  in the plugin's `components/ui` and `lib/` (the `@/` alias), so move anything shadcn writes under `src/`.
- Before installing: `npx tsc --noEmit`, `npm test` where a plugin has tests, and `bb plugin build`. Installs are
  path installs from the plugin's folder: `bb plugin install .`, then `bb plugin reload <name>` after rebuilds.
- Document each plugin's commands and constraints in its own `skills/<name>/SKILL.md`.
- `dist/` is never committed; git installs build from source.
