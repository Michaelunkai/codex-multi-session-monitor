# Codex Multi-Session Monitor — Task Plan

## Goal

Build, install, configure, test, and leave operational an Android-friendly, read-only, near-real-time dashboard for all relevant Windows Codex Desktop sessions, with every project-controlled artifact under `F:\backup\windowsapps\installed\Codex-MultiSession-Monitor`.

## Requirement Ledger

- Requested outcome: one dashboard showing many existing Codex Desktop sessions concurrently.
- Required states: running, waiting/attention, completed, error/stuck, inactive/unknown, with honest reliability labels.
- Required telemetry: title, activity/output/progress, elapsed/last update, project/working directory, attention state where available.
- Authorized mutations: create the F: project, install/configure only project-contained components, create launcher/stop/status scripts, run dashboard, and use a secure Android access method; do not mutate Codex installation or existing Codex state.
- Storage boundary: project-controlled files, runtimes, caches, temp, logs, state, downloads, and tunnel/configuration remain under the mandatory F: root whenever technically controllable.
- Proof required: current-option research, telemetry discovery, multi-session detection, live update, 10-card UI, health, restart recovery, Codex non-interference, F: containment audit, Android endpoint test, and README/logs.

## Phases

### Phase 1 — Discovery and current compatibility research

**Status:** complete

Inspect Windows/F:, running Codex processes, state stores, available runtimes, and current monitor options. Record evidence in `findings.md` and `.agents/research/`.

Evidence is recorded. The official app-server is the richest documented protocol but the running Desktop process is an internal stdio app-server with no discovered external listener. AgentsView and HUD were inspected from source; neither satisfies the full Android/storage contract as-is. Proceed with a custom F:-resident adapter using the confirmed read-only SQLite/JSONL telemetry.

### Phase 2 — Architecture and implementation

**Status:** complete

Implement a dependency-light F:-resident Node service (built-in `node:sqlite` if supported by the pinned portable runtime), an Android-first static UI, bounded read-only Codex adapter, and launcher scripts. Keep a PowerShell fallback only for diagnostics if needed.

### Phase 3 — Local end-to-end validation

**Status:** PC data/API/SSE/DOM and lifecycle tests complete; rendered Chrome verification blocked

Validate real session discovery, status mapping, automatic updates, 10+ cards, health, logs, restart, and Codex non-interference.

### Phase 4 — Android access and containment audit

**Status:** private HTTPS and containment verified on PC; phone confirmation pending

Choose and configure the safest viable private access path, test it locally, audit project-controlled writes, and inspect C: for attributable residue.

### Phase 5 — Documentation and handoff

**Status:** complete with the phone/rendered-verification boundary documented

Write README, preserve logs/evidence, re-run final checks, and report exact address, access method, detected sessions, limitations, and script paths.

## Decisions Made

- Use the mandatory F: root as the project root.
- Keep existing Codex files read-only; the monitor will observe them in place.
- Research and exploration run inline because no sub-agent launcher was available.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| PowerShell `New-Item` rejected `-LiteralPath` for a directory | 1 | Switched to `-Path`; directories were created successfully. |
| `Get-Volume` was unavailable in the current PowerShell environment | 1 | Use `Get-PSDrive` plus CIM/WMI filesystem queries for disk evidence. |
| PowerShell pipeline to `python -` only launched the interactive banner | 1 | Switched to `python -c` with the same in-memory diagnostic source; the schema query then completed. |
| Initial Node extraction command was rejected because it contained conditional recursive `Remove-Item` | 1 | Used a unique F:-resident extraction directory and avoided destructive cleanup; the portable runtime was installed and checksum-verified. |
| Self-signed certificate helper returned a null ECDSA provider, then selected an RSA constructor without signing padding | 2 | Switched to RSA-2048 with the explicit `RSASignaturePadding.Pkcs1` constructor; no certificate-store or system install is used. |
| Requested default port 8765 was already held by an unrelated Windows receiver and excluded from normal binds | 1 | Added a bounded localhost/private-IP availability probe; START selects the first free port in a 50-port range and records the chosen port in config/runtime. |
| PowerShell-generated JSON contained a UTF-8 BOM that the Node JSON reader did not accept, causing fallback to default port 8765 | 1 | Made Node config/index reads BOM-tolerant and changed config writes to UTF-8 without BOM. |
| STATUS.ps1 used a bare PowerShell `if` expression inside string parentheses | 1 | Compute the effective port in a separate variable before formatting the status object. |
| Duplicate START checked the existing PID only after rewriting config, so a healthy listener could be left with a mismatched configured port | 1 | Reconcile a healthy exact PID/runtime before port probing or config writes; stop only an exact unhealthy F:-resident monitor during recovery. |
| The All-non-archived scope initially displayed relevant-only status totals and had no explicit Unknown filter | 1 | Make summary counts scope-aware and expose an Unknown filter in the dashboard. |
| HEALTH.ps1 only checked for a PID and could report success while the endpoint was unhealthy | 1 | Add an authenticated HTTP health probe and nonzero failure exit code; add a matching HEALTH.cmd wrapper. |
| Server stderr retained an earlier recovered bind error across restarts | 1 | Clear the project-owned current stdout/stderr files immediately before each new process start; installation.log retains the historical failure record. |
| SSE initially always sent the Relevant scope, which could replace an All-non-archived view after a live update | 1 | Make subscribers scope-aware, hash all rows for change detection, and reconnect the browser stream when scope changes. |
| A DHCP/private-IP change could leave the existing self-signed certificate without the new IP in its SAN | 1 | Persist the certificate bind host under F: and regenerate only when the bind host changes or `-Force` is requested. |

## Next Step

Leave the healthy stack running. User opens the private access link on Android and confirms the visible cards/update behavior. No further installation or account sign-in is required for same-LAN access. Rendered Chrome verification is blocked by the approved connector's missing kernel assets; do not claim a screenshot or phone-side result.

## Final evidence

- `logs/live-proof.json`: certificate-pinned HTTPS, unauthenticated 401, all unique session IDs, successful assets, two changed live SSE frames.
- `logs/recovery-proof.json`: exact monitor crash, recovered in 25 seconds, Codex PIDs unchanged.
- `logs/storage-audit.json`: F: NTFS, project size, no reparse points, targeted C: residue scan, restrictive secret ACLs.
- `scripts/TEST.cmd`: six passing tests, including execution of the actual UI against 12 synthetic sessions in a DOM harness.
- Windows task `Codex-MultiSession-Monitor`: registered with least privilege and logon trigger; task/supervisor execution verified. No reboot performed.

## Current 2.0.0 acceptance correction — 2026-09-10

The latest user requirement supersedes the earlier multi-status/relevant-scope UI: the dashboard must show running sessions only. The API, SSE stream, and UI are now locked to `running-now`. A real card requires an unfinished rollout (`task_started` without a matching terminal event), a known turn id, and a fresh write within 20 seconds. Historical database rows and old `inProgress` rows are hidden.

The live wall uses complete durable rollout event/item text with whitespace preserved and large per-card transcript panes. The current Codex projection has no word-delta stream; literal word-by-word pre-persistence mirroring remains an explicit technical limitation because the Desktop app-server is internal stdio and must not be intercepted.

Current evidence: 9 portable-Node adapter/live/UI tests pass; `logs/live-proof.json` records 12 unique running cards, complete durable-output matching, authenticated HTTPS, 401 without credentials, and changed SSE frames; `logs/recovery-proof.json` records 23-second recovery with unchanged Codex PIDs; `logs/storage-audit.json` records NTFS, 0 reparse points, and 0 targeted project-named C: residues. Android network proof is pending only because the previously authorized device transport was disconnected during this run; the endpoint itself is covered by the PC HTTPS/SSE proof.
