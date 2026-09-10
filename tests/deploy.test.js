'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('hosted bundle is the same running-only UI and contains no local secrets', () => {
  const source = ['index.html', 'app.js', 'styles.css'].map((name) => fs.readFileSync(path.join(root, 'app', 'public', name), 'utf8'));
  const deployed = ['index.html', 'app.js', 'styles.css'].map((name) => fs.readFileSync(path.join(root, 'deploy', name), 'utf8'));
  const normalizeEndpoint = (html) => html.replace(/(<meta name="codex-monitor-endpoint" content=")[^"]*(">)/, '$1$2');
  assert.deepEqual(deployed.map(normalizeEndpoint), source.map(normalizeEndpoint), 'deploy bundle must be regenerated from app/public before publishing');
  assert.match(deployed[0], /id="cards"/);
  assert.match(deployed[1], /failClosedSnapshot/);
  assert.match(deployed[1], /endpoint/);
  assert.match(deployed[1], /localProbe/);
  assert.match(deployed[1], /renderActivity/);
  assert.match(deployed[0], /codex-monitor-local-endpoint/);
  assert.match(deployed[2], /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(deployed[2], /\.session-index-row/);
  assert.match(deployed[0], /id="sessionIndex"/);
  for (const asset of deployed) {
    assert.doesNotMatch(asset, /access\.token|server-key\.pem|state_5\.sqlite|thread_history_1\.sqlite|session_index\.jsonl/i);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(vercel.rewrites[0].destination, '/deploy/index.html');
  assert.equal(vercel.rewrites[1].destination, '/deploy/$1');
});

test('automatic startup uses a direct F-resident Run value and retires only the project-owned legacy task', () => {
  const autostart = fs.readFileSync(path.join(root, 'scripts', 'ENABLE-AUTOSTART.ps1'), 'utf8');
  const disableAutostart = fs.readFileSync(path.join(root, 'scripts', 'DISABLE-AUTOSTART.ps1'), 'utf8');
  const detachedLauncher = fs.readFileSync(path.join(root, 'scripts', 'AUTOSTART.vbs'), 'utf8');
  assert.match(autostart, /HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(autostart, /wscript\.exe/);
  assert.match(autostart, /AUTOSTART\.vbs/);
  assert.match(autostart, /Remove-ProjectLegacyTask/);
  assert.match(autostart, /\$taskXml -notmatch/);
  assert.doesNotMatch(autostart, /RunCommandHidden/);
  assert.match(disableAutostart, /Remove-ItemProperty/);
  assert.match(disableAutostart, /Codex-MultiSession-Monitor/);
  assert.match(detachedLauncher, /WScript\.Shell/);
  assert.match(detachedLauncher, /shell\.Run command, 0, False/);
  assert.match(detachedLauncher, /runtime\\powershell\\pwsh\.exe/);
  assert.match(detachedLauncher, /START\.ps1/);
  const start = fs.readFileSync(path.join(root, 'scripts', 'START.ps1'), 'utf8');
  const status = fs.readFileSync(path.join(root, 'scripts', 'STATUS.ps1'), 'utf8');
  const stop = fs.readFileSync(path.join(root, 'scripts', 'STOP.ps1'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'scripts', 'HEALTH.ps1'), 'utf8');
  for (const script of [start, status, stop, health]) assert.match(script, /codex-monitor-node\.exe/);
  assert.match(start, /Copy-Item -LiteralPath \$genericNode/);
});

test('supervisor keeps polling after an unexpected loop exception', () => {
  const supervisor = fs.readFileSync(path.join(root, 'scripts', 'supervisor.js'), 'utf8');
  assert.match(supervisor, /Supervisor loop error/);
  assert.match(supervisor, /while\s*\(!fs\.existsSync\(stopFile\)\)/);
});
