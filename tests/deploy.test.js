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
  assert.match(deployed[2], /minmax\(480px, 1fr\)/);
  for (const asset of deployed) {
    assert.doesNotMatch(asset, /access\.token|server-key\.pem|state_5\.sqlite|thread_history_1\.sqlite|session_index\.jsonl/i);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(vercel.rewrites[0].destination, '/deploy/index.html');
  assert.equal(vercel.rewrites[1].destination, '/deploy/$1');
});
