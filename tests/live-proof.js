'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const assert = require('node:assert/strict');
const { parseLiveRollout } = require('../app/server.js');

const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'monitor.json'), 'utf8'));
const token = fs.readFileSync(cfg.auth.tokenFile, 'utf8').trim();
const transport = cfg.tls && cfg.tls.enabled ? https : http;
const options = {
  hostname: cfg.bindHost,
  port: cfg.port,
  headers: {
    Authorization: 'Bearer ' + token,
    Origin: 'https://michaelunkai.github.io'
  }
};
if (cfg.tls && cfg.tls.enabled) options.ca = fs.readFileSync(cfg.tls.certFile);

function get(url, auth = true, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { ...options.headers, ...extraHeaders } : extraHeaders;
    const request = transport.get({ ...options, path: url, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.setTimeout(15000, () => { request.destroy(); reject(Error('HTTP timeout')); });
  });
}

function summarizeFrame(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    cards: snapshot.sessions.length,
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      outputDigest: session.outputDigest,
      outputChars: session.outputChars,
      activity: session.activity && [session.activity.kind, session.activity.label, session.activity.detail, session.activity.ordinal]
    })).sort((left, right) => left.id.localeCompare(right.id))
  };
}

function framesDiffer(left, right) {
  return Boolean(left && right && JSON.stringify(left.sessions) !== JSON.stringify(right.sessions));
}

function streamProof() {
  return new Promise((resolve, reject) => {
    const seen = [];
    let pending = '';
    let request;
    let meaningfulChange = false;
    const finish = () => {
      if (request) request.destroy();
      resolve({ frames: seen.length, changed: seen.length > 1, meaningfulChange, first: seen[0] || null, latest: seen.at(-1) || null });
    };
    const timer = setTimeout(finish, 22000);
    request = transport.get({ ...options, path: '/events' }, (response) => {
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
            assert.equal(snapshot.sessions.every((session) => session.status === 'RUNNING'), true);
            const frame = summarizeFrame(snapshot);
            if (framesDiffer(seen.at(-1), frame)) meaningfulChange = true;
            seen.push(frame);
            if (meaningfulChange) {
              clearTimeout(timer);
              finish();
              return;
            }
          } catch (error) {
            clearTimeout(timer);
            if (request) request.destroy();
            reject(error);
            return;
          }
        }
      });
    });
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

(async () => {
  const results = await Promise.all([
    get('/api/health'),
    get('/api/liveness'),
    get('/api/snapshot?scope=all'),
    get('/api/health', false),
    get('/api/snapshot', false, { Origin: 'https://michaelunkai.github.io' }),
    get('/'),
    get('/app.js'),
    get('/styles.css')
  ]);
  const health = JSON.parse(results[0].body);
  const liveness = JSON.parse(results[1].body);
  const live = JSON.parse(results[2].body);
  const localLive = JSON.parse(results[4].body);
  assert.equal(health.ok, true);
  assert.equal(liveness.ok, true);
  assert.equal(liveness.readOnly, true);
  assert.equal(results[0].headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
  assert.equal(results[2].headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
  assert.equal(results[3].status, 200);
  assert.equal(results[4].status, 200);
  assert.equal(results[4].headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
  assert.equal(localLive.scope, 'running-now');
  assert.equal(localLive.displayMode, 'running-only');
  assert.equal(localLive.sessions.every((session) => session.status === 'RUNNING'), true);
  assert.equal(live.scope, 'running-now');
  assert.equal(live.summary.displayMode, 'running-only');
  assert.equal(live.summary.liveTransport && live.summary.liveTransport.connected, true);
  assert.equal(live.summary.liveTransport && live.summary.liveTransport.initialized, true);
  assert.equal(new Set(live.sessions.map((session) => session.id)).size, live.sessions.length);
  assert.equal(live.sessions.every((session) => session.status === 'RUNNING'), true);
  assert.equal(live.sessions.every((session) => Array.isArray(session.liveOutput)), true);
  assert.equal(live.sessions.every((session) => session.liveTransport === 'codex-ipc'), true, 'every live card must come from the direct Codex Desktop stream');
  assert.equal(live.sessions.every((session) => session.liveOutput.every((entry) => entry.source === 'codex-ipc')), true, 'every displayed entry must be sourced from the direct Codex Desktop stream');
  assert.equal(live.sessions.every((session) => session.activity && session.activity.source === 'codex-ipc'), true, 'every displayed activity must be sourced from the direct Codex Desktop stream');
  assert.equal(live.sessions.every((session) => session.activity && session.activity.label && session.activity.at), true);
  assert.match(results[5].body, /Live wall/);
  assert.match(results[6].body, /renderTranscript/);
  assert.match(results[7].body, /\.live-transcript/);
  const current = live.sessions.find((session) => session.id === '01a08737-04b6-7143-832f-25e6c32126c1');
  assert.ok(current, 'current Codex monitor task must be visible as a live card');
  assert.ok(current.liveOutput.length > 0, 'current live card must expose durable output');
  assert.ok(current.activity && current.activity.label, 'current live card must expose current activity');
  const currentRollout = parseLiveRollout(fs.readFileSync(current.sessionPath, 'utf8'), { now: Date.now() });
  assert.equal(currentRollout.active, true);
  assert.equal(currentRollout.turnId, current.latestTurnId);
  const exactLongEntry = currentRollout.entries.find((entry) => entry.type === 'assistant' && entry.text.length > 320);
  const exactOutputMatch = exactLongEntry
    ? current.liveOutput.some((entry) => entry.text === exactLongEntry.text)
    : current.liveOutput.some((entry) => entry.text.length > 320);
  assert.equal(exactOutputMatch, true, 'dashboard must preserve complete durable output text');
  const stream = await streamProof();
  assert.equal(stream.changed, true, 'authenticated SSE must deliver an automatic changed snapshot');
  const streamContentChanged = stream.meaningfulChange;
  assert.equal(streamContentChanged, true, 'automatic SSE proof must include a changed per-session activity or output payload');
  const report = {
    checkedAt: new Date().toISOString(),
    version: health.serverVersion,
    address: (cfg.tls && cfg.tls.enabled ? 'https://' : 'http://') + cfg.bindHost + ':' + cfg.port,
    tls: cfg.tls && cfg.tls.enabled ? 'Certificate pinned to generated project certificate; hostname verified' : 'Loopback HTTP only; remote access remains HTTPS through the authenticated Funnel',
    health: true,
    localUnauthenticated: { healthStatus: results[3].status, snapshotStatus: results[4].status, runningSessions: localLive.sessions.length },
    discoveredNonArchived: live.summary.totalNonArchived,
    runningSessions: live.sessions.length,
    hiddenHistory: live.summary.hiddenNonRunningCount,
    outputSessions: live.sessions.filter((session) => session.liveOutput.length > 0).length,
    allCardsRunning: live.sessions.every((session) => session.status === 'RUNNING'),
    directIpc: {
      connected: live.summary.liveTransport.connected,
      initialized: live.summary.liveTransport.initialized,
      followingCount: live.summary.liveTransport.followingCount,
      liveStateCount: live.summary.liveTransport.liveStateCount,
      directCards: live.sessions.filter((session) => session.liveTransport === 'codex-ipc').length
    },
    currentTask: { id: current.id, status: current.status, turnId: current.latestTurnId, activity: current.activity, outputEntries: current.liveOutput.length, outputChars: current.outputChars },
    exactDurableOutputMatch: exactOutputMatch,
    assets: results.slice(5).map((result) => ({ status: result.status, bytes: result.body.length })),
    stream,
    streamActivityChanged: stream.meaningfulChange,
    streamContentChanged,
    readErrors: health.summary.readErrors,
    telemetryErrors: health.summary.telemetryErrorCount,
    renderedBrowser: 'Not claimed: approved browser connector was unavailable; network/API/SSE proof completed.'
  };
  fs.writeFileSync(path.join(root, 'logs', 'live-proof.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
