# Contributing

Thanks for helping finish this work-in-progress. The project is deliberately open for takeover by anyone who wants to improve it.

## Start here

1. Read [README.md](README.md) and [WIP.md](WIP.md).
2. Work from a fork or a feature branch.
3. Keep the monitor read-only: do not modify Codex databases, rollout files, the Codex installation, or Codex control state.
4. Keep credentials, bearer links, tokens, local IPs, device serials, runtime state, logs, downloaded archives, and generated caches out of commits.
5. Run the complete test set before opening a pull request:

   ```text
   node --test tests\adapter.test.js tests\deploy.test.js tests\live-telemetry.test.js tests\live-update.test.js tests\ui.test.js
   ```

6. If you change the hosted wall, synchronize the three public assets from `app/public` into both `deploy` and the separate `public-site` checkout, then run the browser/public proofs with a local token supplied through the environment or the existing local config. Never print or commit that token.

## Good first contributions

- Android browser visual verification and responsive improvements.
- Clean-machine installation and upgrade automation.
- CI coverage for the adapter, public wall, and IPC reconnect behavior.
- Additional fixtures for completion races, reconnects, large transcripts, and Codex version changes.
- Clearer contributor-facing documentation and release packaging.

Please describe what you tested, which Codex/Windows versions you used, and whether your change affects the local monitor, the Pages-only site, or both.
