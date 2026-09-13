# Work in progress

This project is intentionally published before it is finished.

The current implementation is a working, read-only Codex Desktop monitor with a public static wall, exact running-session filtering, Desktop IPC tracking, rollout fallback tracking, live SSE deltas, readable typed transcripts, and automated tests. It is not a polished release and it is not production-supported.

## Remaining work

- Complete physical Android browser visual verification and improve mobile ergonomics from that real-device feedback.
- Harden packaging, first-run setup, upgrades, and removal for machines other than the original development PC.
- Add continuous integration and a repeatable clean-machine test matrix.
- Exercise more Codex Desktop versions, IPC reconnects, very large transcripts, and unusual completion/error races.
- Review the private bridge and access-link lifecycle with additional contributors before treating it as a release-quality deployment.

These are invitations, not restrictions. If you want to finish any part of the project, fork it, open an issue describing the direction, or submit a pull request. Please preserve the read-only boundary around Codex state and never commit credentials, live session data, local runtime folders, or machine-specific identifiers.
