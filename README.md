# Codex Multi-Session Monitor

An F:-resident, read-only monitoring wall for the existing Windows ChatGPT Codex Desktop sessions. It is built for one Android screen that can watch many sessions concurrently. It does not control, pause, resume, or rewrite Codex.

## Architecture and exact versions

- Adapter/server: `2.0.0`, dependency-free Node.js production code.
- Portable Node.js: `v24.21.0` Windows x64, stored in `runtime\node` and using built-in `node:sqlite`.
- Portable PowerShell launcher: `7.6.6`, stored in `runtime\powershell`.
- Test-only DOM dependency: LinkeDOM `0.18.12`; its package cache and dependencies are under this root.
- Dashboard: local HTML/CSS/JavaScript, authenticated Server-Sent Events (SSE), 500 ms polling fallback, running-only responsive live wall.
- Access: private-LAN HTTPS using an F:-resident self-signed RSA-2048 certificate and a random bearer token. The current address is printed by `STATUS.ps1 -ShowAccessUrl`; the current port is `8766` because `8765` is already reserved by an unrelated listener.

AgentsView and Codex Monitor HUD were checked before implementation. AgentsView is useful for local history but is not an Android-first live wall for this Desktop state; HUD is a Windows overlay and uses `%LOCALAPPDATA%`. The official Codex app-server is richer, but this Desktop instance exposes its server internally through stdio. The monitor therefore observes the existing local projections read-only and does not start or attach to a second app-server.

## What is shown

The API and UI are deliberately locked to **RUNNING NOW**. A card is sent only when all of these are true:

1. The session has a local rollout record with `task_started` and no matching `task_complete`/terminal task event.
2. A current turn id is known.
3. The rollout has been written within the 20-second live window.

Completed, stale, interrupted, cancelled, failed, archived, and historical sessions are not rendered as cards. They are counted as hidden history in the summary only. A historical database row, a live-looking process name, or an old `inProgress` flag cannot by itself make a session appear RUNNING.

Each card shows the title, project, model/source, working directory, current turn id, last event time, elapsed time, output character count, and the current turn's complete durable output entries. Assistant messages, command output, tool results, and other user-visible rollout text are displayed in large independently scrollable transcript panes with whitespace preserved. The UI uses one column on narrow Android screens and a minimum 480-pixel card width on larger screens, so ten or more cards remain readable by scrolling the wall rather than compressing them into tiny tiles.

## Output and real-time reliability

The tracker reads appended rollout JSONL records incrementally. On each complete record it updates the authenticated SSE snapshot; the browser reconnects automatically and falls back to polling. It keeps the current turn's complete durable output in memory for the dashboard and does not substitute a short preview for the transcript. Common credential-shaped strings are redacted before leaving the adapter. A 5,000,000-character per-session safety ceiling prevents one pathological file from exhausting the monitor.

Important boundary: the safe local rollout projection does not contain token/word-delta events for this Desktop build. It records complete durable event/item records. The dashboard therefore updates at the earliest point that Codex has persisted each event, not before that persistence. It cannot truthfully promise token-by-token or literal word-by-word rendering, and it must not claim to show an approval prompt unless the underlying telemetry explicitly records one. Official Codex Remote remains the control path for opening and operating an individual task.

## Detection sources

The adapter opens these existing Codex files read-only:

- `C:\Users\micha\.codex\state_5.sqlite`: non-archived thread metadata, title, project/working directory, model, timestamps, and rollout path.
- `C:\Users\micha\.codex\thread_history_1.sqlite`: thread/turn metadata and durable item fallback.
- `C:\Users\micha\.codex\session_index.jsonl`: official renamed titles when present.
- The referenced rollout JSONL files under `C:\Users\micha\.codex\sessions`: live task and output events.

No Codex file is written, copied, relocated, or opened for exclusive access. Existing paths outside F: are source inputs only.

## Start, stop, status, and restart

Use the obvious wrappers from any normal Windows shell:

```powershell
& 'F:\backup\windowsapps\installed\Codex-MultiSession-Monitor\scripts\START.cmd'
& 'F:\backup\windowsapps\installed\Codex-MultiSession-Monitor\scripts\STATUS.cmd'
& 'F:\backup\windowsapps\installed\Codex-MultiSession-Monitor\scripts\HEALTH.cmd'
& 'F:\backup\windowsapps\installed\Codex-MultiSession-Monitor\scripts\STOP.cmd'
```

The wrappers force the portable F:-resident PowerShell runtime; this avoids Windows PowerShell 5.1 certificate-option differences. START sets TEMP/TMP and package caches under F:, validates the portable runtimes and source paths, avoids duplicate monitor instances, selects a free port, starts the supervisor, waits for authenticated health, and prints both PC and Android addresses. Restart is STOP followed by START. All controlled logs are under `logs`.

Automatic startup is registered as the Windows task `Codex-MultiSession-Monitor`, using the current interactive user at least privilege and the F:-resident supervisor. It starts after logon and restarts the monitor after health failures. STOP intentionally signals the supervisor to exit. Use `ENABLE-AUTOSTART.ps1` and `DISABLE-AUTOSTART.ps1` to manage that one task. Windows task metadata is the only intentional OS registration outside F:; no service, global PATH change, firewall rule, or certificate-store entry is installed.

## Android: exact use

1. On the PC, run `F:\backup\windowsapps\installed\Codex-MultiSession-Monitor\scripts\STATUS.cmd -ShowAccessUrl` (or double-click START.cmd first).
2. Keep the Android phone and PC on the same private Wi-Fi/LAN.
3. Copy the complete **Android/private access URL** printed by the command. It looks like `https://192.168.1.129:8766/#token=...`; the token is intentionally in the URL fragment.
4. Open that complete link in Chrome on Android. Accept the one-time warning for the local self-signed certificate, if shown.
5. Bookmark the resulting page. Leave it open: cards update automatically. Scroll vertically to inspect every running session; scroll inside a card's transcript pane to read its current output.

Use the full URL, not the bare IP/port. Do not share it: it contains the local bearer token. If the PC changes private IP or port, obtain a new URL from STATUS. This is private-LAN access only; cellular/off-LAN access requires a separately authorized VPN and none is installed by this project.

## Security model

The server binds only to a private RFC1918 interface, uses HTTPS, requires the bearer token for health, snapshots, and SSE, accepts only GET/HEAD, serves no CORS API, and uses no-store/no-referrer headers. The static shell contains no session data. Token and private-key ACLs are limited to the current user and SYSTEM. No public tunnel, unrestricted listener, SMB/RDP rule, firewall weakening, or authentication bypass was added.

Windows and Codex may create unavoidable metadata outside F:. This project redirects its runtimes, dependencies, caches, temporary files, configuration, state, logs, certificates, and scripts to this root wherever technically controllable. The existing Codex installation and state were preserved.

## Directory layout

```text
app/                 Node adapter and static dashboard
runtime/node/        portable Node.js runtime
runtime/powershell/  portable PowerShell launcher runtime
config/              monitor config, token, and TLS files
data/                PID and supervisor runtime records
logs/                install, startup, health, proof, and server logs
cache/ temp/         project-local caches and temporary files
downloads/           verified archives and research material
scripts/             START, STOP, STATUS, HEALTH, and maintenance helpers
tests/               adapter, telemetry, live-update, UI, Android, and recovery proofs
docs/ .agents/       project notes and research evidence
```

## Troubleshooting

- **401 or Token needed:** use the complete URL from START or `STATUS.cmd -ShowAccessUrl`; do not open the bare API URL.
- **Certificate warning:** expected once for the local self-signed certificate. Verify the URL is the PC's private address before accepting it.
- **No cards:** STATUS should report `RunningSessions`. A session is hidden immediately after its durable terminal event or after its 20-second rollout freshness window expires.
- **No Android connection:** confirm both devices are on the same private LAN, use the current STATUS URL, and run `HEALTH.ps1`. No global firewall change is made automatically.
- **Telemetry errors:** inspect `STATUS.ps1`, `logs\server.stderr.log`, and the current Codex source paths. A nonzero telemetry-error count can represent old/missing rollout references and does not turn stale sessions into RUNNING cards.
- **Need to act on a task:** use official Codex Remote or the Codex Desktop app; this dashboard is read-only.

## Uninstall

Run `DISABLE-AUTOSTART.ps1`, then `STOP.cmd`. Confirm the exact F:-resident monitor process is stopped. If removal is desired, delete only this exact directory:

`F:\backup\windowsapps\installed\Codex-MultiSession-Monitor`

Do not remove `C:\Users\micha\.codex`, the WindowsApps Codex installation, or any other path. No system service, firewall rule, or certificate-store item belongs to this project.

## Safe updates

Keep all new archives, caches, temporary files, dependencies, and build output under this root. Review changes to `app` and `scripts`, run `scripts\TEST.cmd`, restart, then run `tests\live-proof.js`, `tests\recovery-proof.ps1`, `tests\android-network-proof.js` when the authorized Android transport is available, and `scripts\AUDIT.ps1`. Before installing any package, set `TEMP`, `TMP`, `NPM_CONFIG_CACHE`, `NPM_CONFIG_PREFIX`, and `XDG_CACHE_HOME` to the project directories. Never use a global install or the system Node/Python installation.

Validation records are kept under `logs` and the source findings under `findings.md` and `task_plan.md`. The approved visible Chrome connector was unavailable during the PC run, so phone browser pixels were not claimed as verified; the Android HTTPS/SSE network path was tested through the authorized device transport.
