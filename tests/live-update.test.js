'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startServer } = require('../app/server.js');

const projectRoot = path.resolve(__dirname, '..');
const fixtureSource = path.join(__dirname, 'fixtures', 'synthetic-12.json');

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

function requestRaw(port, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

function signature(snapshot) {
  return snapshot.sessions.map((session) => session.status + ':' + session.outputDigest).join('|');
}

function waitForChangedSnapshot(port, initialSignature) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/events?scope=all' }, (response) => {
      let buffer = '';
      const deadline = setTimeout(() => {
        request.destroy();
        reject(new Error('Timed out waiting for an automatic SSE snapshot update.'));
      }, 6_000);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const snapshot = JSON.parse(dataLine.slice(6));
            if (signature(snapshot) !== initialSignature) {
              clearTimeout(deadline);
              request.destroy();
              resolve(snapshot);
              return;
            }
          } catch {}
        }
      });
      response.on('error', (error) => { clearTimeout(deadline); reject(error); });
    });
    request.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
  });
}

test('running-only 12-session dashboard endpoint and SSE update work without Codex writes', async () => {
  const testRoot = path.join(projectRoot, 'temp', 'synthetic-live-test');
  const fixture = path.join(testRoot, 'fixture.json');
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(testRoot, { recursive: true });
  fs.copyFileSync(fixtureSource, fixture);
  const fixtureData = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  fixtureData.sessions.forEach((session, index) => {
    session.status = 'RUNNING';
    session.latestOutput = 'Synthetic live stream ' + (index + 1);
  });
  fs.writeFileSync(fixture, JSON.stringify(fixtureData, null, 2), 'utf8');
  let running;
  try {
    running = await startServer({
      root: testRoot,
      configPath: path.join(testRoot, 'config.json'),
      syntheticFile: fixture,
      config: {
        bindHost: '127.0.0.1',
        port: 0,
        pollMs: 250,
        corsOrigins: ['https://deploy.example'],
        auth: { required: false },
        tls: { enabled: false }
      }
    });
    const port = running.runtime.port;
    const liveness = await requestJson(port, '/api/liveness');
    assert.equal(liveness.statusCode, 200);
    assert.equal(liveness.body.ok, true);
    assert.equal(liveness.body.readOnly, true);
    const initial = await requestJson(port, '/api/snapshot?scope=all');
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.body.scope, 'running-now');
    assert.equal(initial.body.summary.totalNonArchived, 12);
    assert.equal(new Set(initial.body.sessions.map((session) => session.id)).size, 12);
    assert.equal(initial.body.sessions.length, 12);
    assert.equal(initial.body.summary.statusCounts.RUNNING, 12);
    assert.equal(initial.body.summary.readOnly, true);
    assert.equal(initial.body.sessions.every((session) => session.status === 'RUNNING'), true);
    assert.equal(initial.body.sessions.every((session) => session.liveOutput.length > 0), true);
    const preflight = await requestRaw(port, 'OPTIONS', '/api/snapshot', {
      Origin: 'https://deploy.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization'
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://deploy.example');
    const crossOrigin = await requestRaw(port, 'GET', '/api/snapshot', { Origin: 'https://deploy.example' });
    assert.equal(crossOrigin.statusCode, 200);
    assert.equal(crossOrigin.headers['access-control-allow-origin'], 'https://deploy.example');
    const initialSignature = signature(initial.body);
    const changedPromise = waitForChangedSnapshot(port, initialSignature);
    fixtureData.sessions[0].latestOutput = 'Automatic live output received';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData, null, 2), 'utf8');
    const changed = await changedPromise;
    assert.equal(changed.scope, 'running-now');
    const changedSession = changed.sessions.find((session) => session.id === 'synthetic-01');
    assert.equal(changedSession.status, 'RUNNING');
    assert.equal(changedSession.liveOutput[0].text, 'Automatic live output received');
    const removedPromise = waitForChangedSnapshot(port, signature(changed));
    fixtureData.sessions[0].status = 'COMPLETED';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData, null, 2), 'utf8');
    const removed = await removedPromise;
    assert.equal(removed.sessions.some((session) => session.id === 'synthetic-01'), false);
    assert.equal(removed.sessions.length, 11);
  } finally {
    if (running) running.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('responsive dashboard source locks the wall to running cards with transcript space', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'app', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'app', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(projectRoot, 'app', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="cards"/);
  assert.match(html, /RUNNING ONLY/);
  assert.doesNotMatch(html, /scopeSelect|data-filter/);
  assert.match(css, /minmax\(480px, 1fr\)/);
  assert.match(css, /\.live-activity/);
  assert.match(css, /\.live-transcript/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(js, /function renderActivity/);
  assert.match(js, /function renderTranscript/);
  assert.match(js, /EventSource/);
});
