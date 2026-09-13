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

function assertLiveSource(session) {
  assert.equal(session.status, 'RUNNING');
  assert.ok(Array.isArray(session.liveOutput));
  assert.ok(session.activity && session.activity.label && session.activity.at);
  if (session.liveTransport === 'codex-ipc') {
    assert.equal(session.activity.source, 'codex-ipc', 'IPC card activity must come from the Desktop IPC stream');
    assert.equal(session.liveOutput.every((entry) => entry.source === 'codex-ipc'), true, 'IPC card output must come from the Desktop IPC stream');
    return { id: session.id, transport: 'codex-ipc', exact: true };
  }
  assert.equal(session.liveTransport, 'codex-rollout-live', 'a non-IPC card must be an append-only live Codex rollout');
  assert.ok(session.sessionPath, 'a rollout-live card must name its Codex rollout file');
  const stat = fs.statSync(session.sessionPath);
  assert.ok(Date.now() - stat.mtimeMs <= (cfg.liveWindowSeconds + 5) * 1000, 'a rollout-live card must have a fresh local write');
  const rollout = parseLiveRollout(fs.readFileSync(session.sessionPath, 'utf8'), { now: Date.now() });
  assert.equal(rollout.active, true, 'a rollout-live card must have an unfinished local task');
  assert.equal(rollout.turnId, session.latestTurnId, 'a rollout-live card must match the active local turn');
  assert.equal(session.activity.source, 'rollout', 'rollout-live card activity must come from its local rollout');
  assert.equal(session.liveOutput.every((entry) => entry.source === 'rollout'), true, 'rollout-live card output must be copied only from its local rollout');
  assert.equal(session.liveOutput.every((entry) => rollout.entries.some((source) => source.text === entry.text)), true, 'rollout-live card output must exactly match its Codex rollout');
  return { id: session.id, transport: 'codex-rollout-live', exact: true };
}

function streamProof() {
  return new Promise((resolve, reject) => {
    const seen = [];
    let pending = '';
    let request;
    let fetching = false;
    let queuedRevision = 0;
    let fetchedRevision = 0;
    let finished = false;
    let meaningfulChange = false;
    let deltaEvents = 0;
    let maxDeltaBytes = 0;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (request) request.destroy();
      if (error) reject(error);
      else resolve({ frames: seen.length, changed: deltaEvents > 0 && meaningfulChange, meaningfulChange, deltaEvents, maxDeltaBytes, first: seen[0] || null, latest: seen.at(-1) || null });
    };
    const timer = setTimeout(finish, 22000);
    const refresh = async (revision) => {
      if (finished) return;
      if (fetching) { queuedRevision = Math.max(queuedRevision, revision); return; }
      fetching = true;
      try {
        const result = await get('/api/snapshot?scope=all');
        assert.equal(result.status, 200);
        const snapshot = JSON.parse(result.body);
        assert.equal(snapshot.scope, 'running-now');
        assert.equal(snapshot.sessions.every((session) => session.status === 'RUNNING'), true);
        const frame = { revision: snapshot.revision, ...summarizeFrame(snapshot) };
        if (framesDiffer(seen.at(-1), frame)) meaningfulChange = true;
        seen.push(frame);
        fetchedRevision = Math.max(fetchedRevision, Number(snapshot.revision) || revision);
        if (meaningfulChange && deltaEvents > 0) finish();
      } catch (error) {
        finish(error);
      } finally {
        fetching = false;
        if (!finished && queuedRevision > fetchedRevision) {
          const next = queuedRevision;
          queuedRevision = 0;
          refresh(next);
        }
      }
    };
    request = transport.get({ ...options, path: '/events?mode=delta' }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = frame.split('\n').find((value) => value.startsWith('event: '));
          const line = frame.split('\n').find((value) => value.startsWith('data: '));
          if (!event || !line) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (event === 'event: changed') {
              assert.equal(Number.isInteger(payload.revision), true);
              if (payload.revision > fetchedRevision) refresh(payload.revision);
              continue;
            }
            if (event !== 'event: delta') continue;
            assert.equal(payload.type, 'delta');
            assert.equal(Number.isInteger(payload.baseRevision), true);
            assert.equal(Number.isInteger(payload.revision), true);
            assert.equal(payload.revision, payload.baseRevision + 1);
            assert.equal(Array.isArray(payload.added), true);
            assert.equal(Array.isArray(payload.updated), true);
            assert.equal(Array.isArray(payload.removedIds), true);
            assert.equal(payload.updated.every((update) => update.session && !Object.hasOwn(update.session, 'liveOutput')), true, 'delta metadata must not repeat a full transcript');
            deltaEvents += 1;
            maxDeltaBytes = Math.max(maxDeltaBytes, Buffer.byteLength(frame));
            if (payload.added.length || payload.updated.length || payload.removedIds.length) meaningfulChange = true;
            if (payload.revision > fetchedRevision) refresh(payload.revision);
            else if (meaningfulChange && seen.length) finish();
          } catch (error) {
            finish(error);
            return;
          }
        }
      });
    });
    request.on('error', (error) => { if (!finished) finish(error); });
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
  assert.equal(live.summary.liveTransport && live.summary.liveTransport.followingCount, live.summary.totalNonArchived, 'Desktop IPC must follow every non-archived task so no running turn can be missed');
  assert.equal(new Set(live.sessions.map((session) => session.id)).size, live.sessions.length);
  assert.equal(live.sessions.every((session) => session.status === 'RUNNING'), true);
  assert.equal(live.sessions.every((session) => Array.isArray(session.liveOutput)), true);
  const sourceProofs = live.sessions.map(assertLiveSource);
  assert.equal(sourceProofs.every((proof) => proof.exact), true, 'every card must be backed by an exact live Codex source');
  assert.match(results[5].body, /Live wall/);
  assert.match(results[6].body, /renderTranscript/);
  assert.match(results[7].body, /\.live-transcript/);
  const current = live.sessions.find((session) => session.liveTransport === 'codex-ipc' && session.sessionPath && session.liveOutput.length > 0);
  assert.ok(current, 'at least one direct Codex live card with durable output must be visible');
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
  assert.equal(stream.changed, true, 'authenticated SSE must deliver an automatic compact live delta');
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
      directCards: live.sessions.filter((session) => session.liveTransport === 'codex-ipc').length,
      rolloutLiveCards: live.sessions.filter((session) => session.liveTransport === 'codex-rollout-live').length
    },
    exactLiveSources: sourceProofs,
    currentTask: { id: current.id, status: current.status, turnId: current.latestTurnId, activity: current.activity, outputEntries: current.liveOutput.length, outputChars: current.outputChars },
    exactDurableOutputMatch: exactOutputMatch,
    assets: results.slice(5).map((result) => ({ status: result.status, bytes: result.body.length })),
    stream,
    sseMode: 'initial full snapshot plus compact ordered per-card delta',
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
