# Sparkmux desktop

Tauri 2 + React + xterm.js front-end for a dedicated `tmux -L sparkmux` server.

End users should follow the [root README](../../README.md#install) (`scripts/install.sh` or a GitHub Release). This folder is the developer loop:

```bash
cd apps/desktop
npm install
npm run tauri dev
```

`cargo tauri` is not a Cargo subcommand. Release bundles: `npm run tauri build` (outputs under the workspace `target/release/bundle`).
