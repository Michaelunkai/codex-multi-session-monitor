'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const https = require('node:https');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'monitor.json'), 'utf8'));
const token = fs.readFileSync(cfg.auth.tokenFile, 'utf8').trim();
const endpoint = (process.env.MONITOR_PUBLIC_ENDPOINT ||
  fs.readFileSync(path.join(root, 'data', 'tailscale', 'public-url.txt'), 'utf8')).trim().replace(/\/$/, '');
const endpointUrl = new URL(endpoint);
if (endpointUrl.protocol !== 'https:' || !/\.ts\.net$/i.test(endpointUrl.hostname)) {
  throw new Error('Expected the configured public endpoint to be an HTTPS ts.net hostname.');
}

async function resolvePublicAddress(hostname) {
  const addresses = await dns.resolve4(hostname);
  if (!addresses.length) throw new Error('No public IPv4 address resolved for ' + hostname);
  return addresses[0];
}

function requestOptions(ip, requestPath, authenticated = true) {
  const headers = { Host: endpointUrl.hostname, Origin: 'https://michaelunkai.github.io' };
  if (authenticated) headers.Authorization = 'Bearer ' + token;
  return {
    hostname: ip,
    servername: endpointUrl.hostname,
    port: Number(endpointUrl.port || 443),
    path: requestPath,
    headers,
    timeout: 15000
  };
}

function get(ip, requestPath, authenticated = true) {
  return new Promise((resolve, reject) => {
    const request = https.get(requestOptions(ip, requestPath, authenticated), (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.setTimeout(15000, () => { request.destroy(); reject(Error('HTTP timeout')); });
  });
}

function streamProof(ip) {
  return new Promise((resolve, reject) => {
    const seen = [];
    let pending = '';
    let request;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (request) request.destroy();
      if (error) reject(error);
      else resolve({ frames: seen.length, changed: seen.length > 1, first: seen[0] || null, latest: seen.at(-1) || null });
    };
    const timer = setTimeout(() => finish(), 22000);
    request = https.get(requestOptions(ip, '/events'), (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const line = frame.split('\n').find((value) => value.startsWith('data: '));
          if (!line) continue;
          try {
            const snapshot = JSON.parse(line.slice(6));
            assert.equal(snapshot.scope, 'running-now');
            assert.equal(snapshot.summary.displayMode, 'running-only');
            assert.equal(snapshot.sessions.every((session) => session.status === 'RUNNING'), true);
            seen.push({
              generatedAt: snapshot.generatedAt,
              cards: snapshot.sessions.length,
              outputEntries: snapshot.sessions.reduce((sum, session) => sum + session.liveOutput.length, 0),
              digests: snapshot.sessions.map((session) => session.outputDigest)
            });
            if (seen.length >= 2) finish();
          } catch (error) {
            finish(error);
          }
        }
      });
      response.on('error', finish);
    });
    request.on('error', (error) => { if (!finished) finish(error); });
  });
}

(async () => {
  const ip = await resolvePublicAddress(endpointUrl.hostname);
  const results = await Promise.all([
    get(ip, '/api/health'),
    get(ip, '/api/snapshot?scope=all'),
    get(ip, '/api/health', false),
    get(ip, '/'),
    get(ip, '/app.js'),
    get(ip, '/styles.css')
  ]);
  const health = JSON.parse(results[0].body);
  const live = JSON.parse(results[1].body);
  assert.equal(health.ok, true);
  assert.equal(results[0].status, 200);
  assert.equal(results[0].headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
  assert.equal(results[1].status, 200);
  assert.equal(results[1].headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
  assert.equal(results[2].status, 401);
  assert.equal(live.scope, 'running-now');
  assert.equal(live.summary.displayMode, 'running-only');
  assert.equal(new Set(live.sessions.map((session) => session.id)).size, live.sessions.length);
  assert.equal(live.sessions.every((session) => session.status === 'RUNNING'), true);
  assert.equal(live.sessions.every((session) => Array.isArray(session.liveOutput)), true);
  assert.match(results[3].body, /Live wall/);
  assert.match(results[4].body, /renderTranscript/);
  assert.match(results[5].body, /\.live-transcript/);
  assert.equal(live.sessions.some((session) => session.liveOutput.length > 0), true, 'live cards must expose durable output');
  const stream = await streamProof(ip);
  assert.equal(stream.changed, true);
  const report = {
    checkedAt: new Date().toISOString(),
    endpoint,
    resolvedPublicAddress: ip,
    health: true,
    unauthenticatedStatus: results[2].status,
    discoveredNonArchived: live.summary.totalNonArchived,
    runningSessions: live.sessions.length,
    uniqueRunningSessions: new Set(live.sessions.map((session) => session.id)).size,
    hiddenHistory: live.summary.hiddenNonRunningCount,
    outputSessions: live.sessions.filter((session) => session.liveOutput.length > 0).length,
    allCardsRunning: live.sessions.every((session) => session.status === 'RUNNING'),
    assets: results.slice(3).map((result) => ({ status: result.status, bytes: result.body.length })),
    stream,
    readErrors: health.summary.readErrors,
    telemetryErrors: health.summary.telemetryErrorCount,
    credentials: 'read from F:-resident token file and sent as an Authorization header; never printed'
  };
  fs.writeFileSync(path.join(root, 'logs', 'public-live-proof.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
