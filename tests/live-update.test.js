'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
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

function waitForChangedSignal(port, minimumRevision) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/events?scope=all&mode=revision' }, (response) => {
      let buffer = '';
      const deadline = setTimeout(() => {
        request.destroy();
        reject(new Error('Timed out waiting for an automatic SSE revision notification.'));
      }, 2_500);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          if (!block.split('\n').some((line) => line === 'event: changed')) continue;
          const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const signal = JSON.parse(dataLine.slice(6));
            if (!Number.isInteger(signal.revision) || signal.revision <= minimumRevision) continue;
            clearTimeout(deadline);
            request.destroy();
            resolve(signal);
            return;
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

function openSse(port, requestPath) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let pending = '';
    const queued = [];
    const waiters = [];
    const dispatch = (event) => {
      const index = waiters.findIndex((waiter) => waiter.predicate(event));
      if (index < 0) {
        queued.push(event);
        return;
      }
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    };
    const fail = (error) => {
      while (waiters.length) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
    const stream = {
      next(predicate, timeout = 2_500) {
        const queuedIndex = queued.findIndex(predicate);
        if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
        return new Promise((resolveNext, rejectNext) => {
          const waiter = { predicate, resolve: resolveNext, reject: rejectNext, timer: null };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            rejectNext(new Error('Timed out waiting for SSE event.'));
          }, timeout);
          waiters.push(waiter);
        });
      },
      close() {
        try { request.destroy(); } catch {}
        try { response.destroy(); } catch {}
      }
    };
    request = http.get({ host: '127.0.0.1', port, path: requestPath }, (incoming) => {
      response = incoming;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const lines = frame.split('\n');
          const eventLine = lines.find((line) => line.startsWith('event: '));
          const dataLine = lines.find((line) => line.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          try { dispatch({ event: eventLine.slice(7), body: JSON.parse(dataLine.slice(6)) }); } catch (error) { fail(error); }
        }
      });
      response.on('error', fail);
      resolve(stream);
    });
    request.on('error', fail);
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function connectPausedSse(port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const fail = (error) => reject(error);
    socket.once('error', fail);
    socket.connect(port, '127.0.0.1', () => {
      socket.write('GET /events?scope=all&mode=revision HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      socket.pause();
      socket.removeListener('error', fail);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}

async function collectPausedSse(socket, milliseconds) {
  let received = '';
  const onData = (chunk) => { received += chunk.toString('utf8'); };
  socket.on('data', onData);
  socket.resume();
  await wait(milliseconds);
  socket.off('data', onData);
  socket.destroy();
  return received;
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
      'Access-Control-Request-Headers': 'authorization',
      'Access-Control-Request-Private-Network': 'true'
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://deploy.example');
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    const crossOrigin = await requestRaw(port, 'GET', '/api/snapshot', { Origin: 'https://deploy.example' });
    assert.equal(crossOrigin.statusCode, 200);
    assert.equal(crossOrigin.headers['access-control-allow-origin'], 'https://deploy.example');
    const changedPromise = waitForChangedSignal(port, initial.body.revision);
    fixtureData.sessions[0].latestOutput = 'Automatic live output received';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData, null, 2), 'utf8');
    const changedSignal = await changedPromise;
    assert.ok(changedSignal.revision >= 1);
    const changedResponse = await requestJson(port, '/api/snapshot?scope=all');
    assert.equal(changedResponse.statusCode, 200);
    const changed = changedResponse.body;
    assert.equal(changed.scope, 'running-now');
    const changedSession = changed.sessions.find((session) => session.id === 'synthetic-01');
    assert.equal(changedSession.status, 'RUNNING');
    assert.equal(changedSession.liveOutput[0].text, 'Automatic live output received');
    const removedPromise = waitForChangedSignal(port, changedSignal.revision);
    fixtureData.sessions[0].status = 'COMPLETED';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData, null, 2), 'utf8');
    const removedSignal = await removedPromise;
    assert.ok(removedSignal.revision > changedSignal.revision);
    const removedResponse = await requestJson(port, '/api/snapshot?scope=all');
    assert.equal(removedResponse.statusCode, 200);
    const removed = removedResponse.body;
    assert.equal(removed.sessions.some((session) => session.id === 'synthetic-01'), false);
    assert.equal(removed.sessions.length, 11);
  } finally {
    if (running) running.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('a paused full-transcript SSE client receives only tiny revision notifications and never stalls liveness', async () => {
  const testRoot = path.join(projectRoot, 'temp', 'slow-sse-client-test');
  const fixture = path.join(testRoot, 'fixture.json');
  const transcript = (marker) => marker + '\n' + 'x'.repeat(8 * 1024 * 1024);
  const fixtureData = {
    sessions: [{
      id: 'slow-sse-session',
      title: 'Slow SSE fixture',
      status: 'RUNNING',
      lastActivityAt: '2026-09-10T00:00:00.000Z',
      activity: { at: '2026-09-10T00:00:00.000Z', timestampMs: 1788998400000, detail: 'Stable test activity' },
      liveOutput: [{ id: 'slow-sse-output', ordinal: 1, text: transcript('snapshot-0') }]
    }]
  };
  let running;
  let pausedSocket;
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
    running = await startServer({
      root: testRoot,
      configPath: path.join(testRoot, 'config.json'),
      syntheticFile: fixture,
      config: {
        bindHost: '127.0.0.1',
        port: 0,
        pollMs: 250,
        auth: { required: false },
        tls: { enabled: false }
      }
    });
    const port = running.runtime.port;
    pausedSocket = await connectPausedSse(port);
    await wait(300);
    for (let index = 1; index <= 4; index += 1) {
      fixtureData.sessions[0].liveOutput[0].text = transcript('snapshot-' + index);
      fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
      await wait(325);
    }
    const livenessStartedAt = Date.now();
    const liveness = await withTimeout(requestJson(port, '/api/liveness'), 1_000, 'Liveness was stalled by a paused SSE client.');
    assert.equal(liveness.statusCode, 200);
    assert.equal(liveness.body.ok, true);
    assert.ok(Date.now() - livenessStartedAt < 1_000, 'Liveness must stay responsive while output is backpressured.');
    const received = await collectPausedSse(pausedSocket, 1_500);
    pausedSocket = null;
    assert.equal((received.match(/event: snapshot/g) || []).length, 0, 'SSE must never queue full transcripts after a client connects.');
    assert.ok((received.match(/event: changed/g) || []).length >= 1, 'The paused client must receive a revision signal after it resumes.');
    assert.ok(Buffer.byteLength(received) < 16 * 1024, 'A paused client must not accumulate full transcript payloads.');
  } finally {
    if (pausedSocket) pausedSocket.destroy();
    if (running) running.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('delta SSE appends one changed transcript fragment without re-sending the full wall', async () => {
  const testRoot = path.join(projectRoot, 'temp', 'delta-sse-test');
  const fixture = path.join(testRoot, 'fixture.json');
  const initialText = 'prefix-' + 'x'.repeat(512 * 1024);
  const fixtureData = {
    sessions: [{
      id: 'delta-session',
      title: 'Delta SSE fixture',
      status: 'RUNNING',
      lastActivityAt: new Date().toISOString(),
      activity: { at: new Date().toISOString(), timestampMs: Date.now(), detail: 'Initial state' },
      latestOutput: initialText
    }, {
      id: 'delta-stable-session',
      title: 'Stable delta fixture',
      status: 'RUNNING',
      lastActivityAt: new Date().toISOString(),
      activity: { at: new Date().toISOString(), timestampMs: Date.now(), detail: 'No new output' },
      latestOutput: 'This session must not be retransmitted when another session changes.'
    }]
  };
  let running;
  let stream;
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
    running = await startServer({
      root: testRoot,
      configPath: path.join(testRoot, 'config.json'),
      syntheticFile: fixture,
      config: { bindHost: '127.0.0.1', port: 0, pollMs: 250, auth: { required: false }, tls: { enabled: false } }
    });
    const port = running.runtime.port;
    const initial = await requestJson(port, '/api/snapshot?scope=all');
    assert.equal(initial.statusCode, 200);
    assert.equal(Object.hasOwn(initial.body.sessions[0].latestItem, 'text'), false, 'full snapshots must not duplicate a transcript entry in latestItem');
    stream = await openSse(port, '/events?scope=all&mode=delta');
    const ready = await stream.next((event) => event.event === 'changed');
    assert.equal(ready.body.revision, initial.body.revision);
    fixtureData.sessions[0].latestOutput = initialText + ' appended-live-word';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
    const delta = await stream.next((event) => event.event === 'delta' && event.body.revision > initial.body.revision);
    assert.equal(delta.body.baseRevision, initial.body.revision);
    assert.deepEqual(delta.body.removedIds, []);
    assert.equal(delta.body.added.length, 0);
    assert.equal(delta.body.updated.length, 1, 'only the card with a real change may be sent in the delta');
    assert.equal(delta.body.updated[0].id, 'delta-session');
    assert.equal(delta.body.updated[0].output.upserts.length, 1);
    assert.equal(delta.body.updated[0].output.upserts[0].appendText, ' appended-live-word');
    assert.equal(JSON.stringify(delta.body).includes(initialText), false, 'delta payload must not repeat the full transcript');
    assert.ok(Buffer.byteLength(JSON.stringify(delta.body)) < 16 * 1024, 'one appended word must produce a compact delta payload');
    const refreshedAt = new Date().toISOString();
    fixtureData.sessions[0].lastActivityAt = refreshedAt;
    fixtureData.sessions[0].activity = { at: refreshedAt, timestampMs: Date.parse(refreshedAt), detail: 'Timestamp refresh only' };
    fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
    const timingOnly = await stream.next((event) => event.event === 'delta' && event.body.revision > delta.body.revision);
    assert.equal(timingOnly.body.updated.length, 1);
    assert.equal(timingOnly.body.updated[0].id, 'delta-session');
    assert.equal(timingOnly.body.updated[0].output, null, 'timestamp-only IPC refreshes must not rewrite unchanged transcript entries');
    fixtureData.sessions[0].status = 'COMPLETED';
    fs.writeFileSync(fixture, JSON.stringify(fixtureData), 'utf8');
    const removed = await stream.next((event) => event.event === 'delta' && event.body.revision > timingOnly.body.revision);
    assert.deepEqual(removed.body.removedIds, ['delta-session']);
  } finally {
    if (stream) stream.close();
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
  assert.match(js, /function accessTokenForCopy/);
  assert.match(js, /function fallbackCopyText/);
});

test('locally connected PC can request the private access token for copy-link generation', async () => {
  const testRoot = path.join(projectRoot, 'temp', 'access-link-test');
  let running;
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    running = await startServer({
      root: testRoot,
      configPath: path.join(testRoot, 'config.json'),
      syntheticFile: path.join(testRoot, 'fixture.json'),
      token: 'a'.repeat(64),
      config: {
        bindHost: '127.0.0.1',
        port: 0,
        auth: { required: true },
        corsOrigins: ['https://michaelunkai.github.io'],
        tls: { enabled: false }
      }
    });
    const preflight = await requestRaw(running.runtime.port, 'OPTIONS', '/api/access-link', {
      Origin: 'https://michaelunkai.github.io',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Private-Network': 'true'
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    const response = await requestRaw(running.runtime.port, 'GET', '/api/access-link', {
      Origin: 'https://michaelunkai.github.io'
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'https://michaelunkai.github.io');
    assert.deepEqual(JSON.parse(response.body), { token: 'a'.repeat(64) });
  } finally {
    if (running) running.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
