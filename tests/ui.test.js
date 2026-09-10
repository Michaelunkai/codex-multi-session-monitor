'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('./ui/node_modules/linkedom');
const { createLiveAdapter, normalizeConfig } = require('../app/server');

const root = path.resolve(__dirname, '..');

test('running-only UI renders 12 simultaneous live transcripts and applies an automatic stream update', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  let snapshot = adapter.snapshot();
  const base = snapshot.sessions[0];
  const longText = 'complete live output '.repeat(40).trim();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.revision = 1;
  snapshot.sessions = Array.from({ length: 12 }, (_, index) => ({
    ...base,
    id: 'synthetic-live-' + String(index + 1).padStart(2, '0'),
    title: 'Live session ' + (index + 1),
    liveTransport: index === 1 ? 'codex-rollout-live' : 'codex-ipc',
    liveOutput: [{ id: 'entry-' + index, type: 'assistant', ordinal: 1, at: new Date().toISOString(), text: index === 0 ? longText : 'stream ' + (index + 1) }],
    latestItem: { type: 'assistant', preview: index === 0 ? longText.slice(0, 320) : 'stream ' + (index + 1), text: index === 0 ? longText : 'stream ' + (index + 1), at: new Date().toISOString() },
    outputDigest: 'digest-' + index,
    outputChars: index === 0 ? longText.length : 8
  }));
  snapshot.summary.runningCount = 12;
  snapshot.summary.relevantCount = 12;

  const streams = [];
  let copied = '';
  let fetchCount = 0;
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: { href: 'https://localhost/#token=test-token', origin: 'https://localhost', pathname: '/', search: '', hash: '#token=test-token' },
    URL,
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    fetch: async () => { fetchCount += 1; return { ok: true, json: async () => snapshot }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.querySelectorAll('.session-card').length, 12);
  assert.equal(document.querySelectorAll('[data-filter]').length, 0);
  assert.equal(document.querySelectorAll('.live-activity').length, 12);
  assert.equal(document.querySelectorAll('.live-transcript').length, 12);
  assert.equal(document.querySelectorAll('.session-index-row').length, 12);
  assert.match(document.querySelector('.session-index-row').textContent, /LATEST OUTPUT/);
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"] .live-transcript').textContent, /complete live output/);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"] .live-activity').textContent, /Synthetic live event/);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"] .transcript-state').textContent, /LIVE DESKTOP IPC · updating now/);
  assert.match(document.querySelector('[data-session-id="synthetic-live-02"] .transcript-state').textContent, /LIVE CODEX ROLLOUT · updating now/);
  assert.doesNotMatch(document.querySelector('[data-session-id="synthetic-live-02"] .transcript-state').textContent, /fallback|waiting/i);
  assert.equal(document.querySelectorAll('.transcript-entry').length, 12);
  assert.match(streams[0].url, /\/events\?mode=delta&token=test-token$/);
  document.querySelector('#copyButton').dispatchEvent(new Event('click'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(copied, /^https:\/\/michaelunkai\.github\.io\/codex-multi-session-monitor-pages\/#token=test-token&endpoint=https%3A%2F%2Fcodex-monitor\.tail5cbd67\.ts\.net$/);

  const originalTextNode = document.querySelector('[data-session-id="synthetic-live-01"] .transcript-text');
  const changedSession = structuredClone(snapshot.sessions[0]);
  const changedActivityAt = new Date(Date.now() + 1000).toISOString();
  changedSession.outputDigest = 'changed-digest';
  changedSession.outputChars += ' word-by-word stream update'.length;
  changedSession.lastActivityAt = changedActivityAt;
  changedSession.latestTurnStartedAt = new Date(Date.now() - 61000).toISOString();
  changedSession.activity = { kind: 'assistant-delta', label: 'Codex output is streaming', detail: '', at: changedActivityAt, timestampMs: Date.now(), ordinal: 2, source: 'codex-ipc' };
  delete changedSession.liveOutput;
  delete changedSession.latestItem.text;
  delete changedSession.lastActivityAgeSeconds;
  delete changedSession.elapsedSeconds;
  streams[0].listeners.delta({ data: JSON.stringify({
    type: 'delta', baseRevision: 1, revision: 2, generatedAt: new Date().toISOString(), source: snapshot.source,
    scope: 'running-now', displayMode: 'running-only', summary: snapshot.summary, added: [], removedIds: [],
    updated: [{ id: 'synthetic-live-01', session: changedSession, output: { mode: 'patch', removedIds: [], upserts: [{ id: 'entry-0', type: 'assistant', ordinal: 1, at: new Date().toISOString(), appendText: ' word-by-word stream update', source: 'codex-ipc' }] } }]
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(document.querySelector('[data-session-id="synthetic-live-01"] .transcript-text'), originalTextNode);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"]').textContent, /word-by-word stream update/);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"] .live-activity').textContent, /Codex output is streaming/);
  assert.equal(document.querySelector('[data-session-id="synthetic-live-01"] .metric-value').dataset.activityAt, changedActivityAt, 'delta metadata must refresh the local age clock');
  assert.equal(fetchCount, 1, 'a compact delta must not cause another full-wall fetch');
  streams[0].listeners.delta({ data: JSON.stringify({
    type: 'delta', baseRevision: 2, revision: 3, generatedAt: new Date().toISOString(), source: snapshot.source,
    scope: 'running-now', displayMode: 'running-only', summary: { ...snapshot.summary, runningCount: 11, relevantCount: 11 }, added: [], updated: [], removedIds: ['synthetic-live-12']
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelectorAll('.session-card').length, 11);
  adapter.close();
});

test('local wall prepares the private token before the copy click', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  snapshot.summary.relevantCount = snapshot.sessions.length;
  const requests = [];
  const copied = [];
  const localToken = 'local-copy-token-' + 'x'.repeat(48);
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: {
      href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/',
      origin: 'https://michaelunkai.github.io',
      pathname: '/codex-multi-session-monitor-pages/',
      search: '',
      hash: ''
    },
    URL,
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, encodeURIComponent,
    setInterval() { return 1; }, setTimeout() { return 1; }, clearInterval() {}, clearTimeout() {},
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === 'http://127.0.0.1:8766/api/access-link') return { ok: true, json: async () => ({ token: localToken }) };
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const accessRequestsBeforeClick = requests.filter((request) => request.url === 'http://127.0.0.1:8766/api/access-link').length;
  assert.equal(accessRequestsBeforeClick, 1, 'the local wall should prepare one token during connection');
  assert.match(document.querySelector('#copyStatus').textContent, /Ready for Android/);
  document.querySelector('#copyButton').dispatchEvent(new Event('click'));
  await new Promise((resolve) => setImmediate(resolve));
  const accessRequestsAfterClick = requests.filter((request) => request.url === 'http://127.0.0.1:8766/api/access-link').length;
  assert.equal(accessRequestsAfterClick, accessRequestsBeforeClick, 'copy click must not wait for a network token request');
  assert.match(copied[0], /^https:\/\/michaelunkai\.github\.io\/codex-multi-session-monitor-pages\/#token=local-copy-token-/);
  adapter.close();
});

test('hosted shell accepts the private PC access URL and targets the live PC origin', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  document.querySelector('meta[name="codex-monitor-local-endpoint"]').setAttribute('content', '');
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  const base = snapshot.sessions[0];
  snapshot.sessions = Array.from({ length: 12 }, (_, index) => ({
    ...base,
    id: 'remote-synthetic-' + String(index + 1).padStart(2, '0'),
    title: 'Remote live session ' + (index + 1),
    status: 'RUNNING',
    liveOutput: [{ id: 'remote-output-' + index, type: 'assistant', ordinal: 1, at: new Date().toISOString(), text: 'remote live output ' + (index + 1) }]
  }));
  snapshot.summary.runningCount = 12;
  snapshot.summary.relevantCount = 12;
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  const requests = [];
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: {
      href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/',
      origin: 'https://michaelunkai.github.io',
      pathname: '/codex-multi-session-monitor-pages/',
      search: '',
      hash: ''
    },
    URL,
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, URL, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), false);
  document.querySelector('#accessInput').value = 'https://192.168.1.129:8766/#token=remote-test-token';
  document.querySelector('#connectButton').dispatchEvent(new Event('click'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(requests[0].url, /^https:\/\/192\.168\.1\.129:8766\/api\/snapshot\?token=remote-test-token$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer remote-test-token');
  assert.match(streams[0].url, /^https:\/\/192\.168\.1\.129:8766\/events\?mode=delta&token=remote-test-token$/);
  assert.equal(document.querySelectorAll('.session-card').length, 12);
  adapter.close();
});

test('same-origin PC wall connects without a bearer link while remote shell stays gated', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  snapshot.summary.relevantCount = snapshot.sessions.length;
  const requests = [];
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: { href: 'https://192.168.1.129:8766/', origin: 'https://192.168.1.129:8766', pathname: '/', search: '', hash: '' },
    URL,
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, URL, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.equal(requests[0].url, 'http://127.0.0.1:8766/api/snapshot');
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(streams[0].url, 'http://127.0.0.1:8766/events?mode=delta');
  assert.equal(document.querySelectorAll('.session-card').length, snapshot.sessions.length);
  adapter.close();
});

test('published wall auto-connects to the local PC before asking remote devices for a link', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  document.querySelector('meta[name="codex-monitor-endpoint"]').setAttribute('content', 'https://codex-monitor.tail5cbd67.ts.net');
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  snapshot.summary.relevantCount = snapshot.sessions.length;
  const requests = [];
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: {
      href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/',
      origin: 'https://michaelunkai.github.io',
      pathname: '/codex-multi-session-monitor-pages/',
      search: '',
      hash: ''
    },
    URL,
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, URL, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true, 'automatic PC probing must not show the remote token form first');
  assert.match(document.querySelector('#connectionBadge').textContent, /Looking for this PC/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.equal(requests[0].url, 'http://127.0.0.1:8766/api/snapshot');
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(streams[0].url, 'http://127.0.0.1:8766/events?mode=delta');
  assert.equal(document.querySelectorAll('.session-card').length, snapshot.sessions.length);
  adapter.close();
});

test('published wall prefers the local PC over a previously saved remote token', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  snapshot.summary.relevantCount = snapshot.sessions.length;
  const requests = [];
  const streams = [];
  const values = new Map([
    ['codex-live-wall-token:https://codex-monitor.tail5cbd67.ts.net', 'saved-remote-token']
  ]);
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: { href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/', origin: 'https://michaelunkai.github.io', pathname: '/codex-multi-session-monitor-pages/', search: '', hash: '' },
    URL,
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); }
    },
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, URL, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].url, 'http://127.0.0.1:8766/api/snapshot');
  assert.equal(requests[0].options.headers, undefined, 'local PC connection must not use the saved remote bearer token');
  assert.equal(streams[0].url, 'http://127.0.0.1:8766/events?mode=delta');
  assert.match(document.querySelector('#connectionBadge').textContent, /Live · this PC/);
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.equal(document.querySelectorAll('.session-card').length, snapshot.sessions.length);
  adapter.close();
});

test('published wall keeps retrying the local PC after a transient monitor restart', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  const delayed = [];
  const streams = [];
  const requests = [];
  let calls = 0;
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: { href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/', origin: 'https://michaelunkai.github.io', pathname: '/codex-multi-session-monitor-pages/', search: '', hash: '' },
    URL,
    history: { replaceState() {} },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, URL, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout(fn) { delayed.push(fn); return delayed.length; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      calls += 1;
      requests.push({ url, options });
      if (calls <= 1) throw new Error('monitor restarting');
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.querySelector('#connectionBadge').textContent, /Looking for this PC/);
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), false);
  const retry = delayed.pop();
  retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.equal(document.querySelectorAll('.session-card').length, snapshot.sessions.length);
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /^http:\/\/127\.0\.0\.1:8766\/events\?mode=delta$/);
  streams[0].onerror();
  assert.equal(delayed.length, 2, 'a local stream failure must schedule both a local probe and event-stream reconnect');
  delayed.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  const snapshotRequests = requests.filter((request) => request.url === 'http://127.0.0.1:8766/api/snapshot');
  assert.equal(snapshotRequests[snapshotRequests.length - 1].url, 'http://127.0.0.1:8766/api/snapshot');
  assert.ok(requests.some((request) => request.url === 'http://127.0.0.1:8766/api/access-link'), 'local connection should prefetch the copy token');
  assert.equal(streams.length, 2, 'the local wall must recover its live stream after a monitor connection failure');
  adapter.close();
});

test('one-tap access link auto-connects, stores the token, and cleans the address bar', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
  document.querySelector('meta[name="codex-monitor-local-endpoint"]').setAttribute('content', '');
  document.querySelector('meta[name="codex-monitor-share-endpoint"]').setAttribute('content', 'https://codex-monitor.example.ts.net');
  const adapter = createLiveAdapter(normalizeConfig({}, root), path.join(__dirname, 'fixtures/synthetic-12.json'));
  const snapshot = adapter.snapshot();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = snapshot.sessions.filter((session) => session.status === 'RUNNING');
  snapshot.summary.runningCount = snapshot.sessions.length;
  const values = new Map();
  const replaced = [];
  const requests = [];
  let copied = '';
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const window = {
    location: {
      href: 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/#token=remote-test-token&endpoint=https%3A%2F%2F192.168.1.129%3A8766',
      origin: 'https://michaelunkai.github.io',
      pathname: '/codex-multi-session-monitor-pages/',
      search: '',
      hash: '#token=remote-test-token&endpoint=https%3A%2F%2F192.168.1.129%3A8766'
    },
    URL,
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); }
    },
    history: { replaceState(state, title, url) { replaced.push(url); } },
    EventSource: FakeEventSource
  };
  const context = {
    document, window, EventSource: FakeEventSource, URLSearchParams, console, Set, Date, encodeURIComponent,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => snapshot };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(requests[0].url, /^https:\/\/192\.168\.1\.129:8766\/api\/snapshot\?token=remote-test-token$/);
  assert.equal(values.get('codex-live-wall-token:https://192.168.1.129:8766'), 'remote-test-token');
  assert.equal(replaced[0], 'https://michaelunkai.github.io/codex-multi-session-monitor-pages/');
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.equal(document.querySelectorAll('.session-card').length, snapshot.sessions.length);
  document.querySelector('#copyButton').dispatchEvent(new Event('click'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(copied, /^https:\/\/michaelunkai\.github\.io\/codex-multi-session-monitor-pages\/#token=remote-test-token&endpoint=https%3A%2F%2Fcodex-monitor\.example\.ts\.net$/);
  adapter.close();
});
