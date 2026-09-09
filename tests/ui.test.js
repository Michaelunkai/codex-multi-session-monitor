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
  const snapshot = adapter.snapshot();
  const base = snapshot.sessions[0];
  const longText = 'complete live output '.repeat(40).trim();
  snapshot.scope = 'running-now';
  snapshot.displayMode = 'running-only';
  snapshot.sessions = Array.from({ length: 12 }, (_, index) => ({
    ...base,
    id: 'synthetic-live-' + String(index + 1).padStart(2, '0'),
    title: 'Live session ' + (index + 1),
    liveOutput: [{ id: 'entry-' + index, type: 'assistant', ordinal: 1, at: new Date().toISOString(), text: index === 0 ? longText : 'stream ' + (index + 1) }],
    latestItem: { type: 'assistant', preview: index === 0 ? longText.slice(0, 320) : 'stream ' + (index + 1), text: index === 0 ? longText : 'stream ' + (index + 1), at: new Date().toISOString() },
    outputDigest: 'digest-' + index,
    outputChars: index === 0 ? longText.length : 8
  }));
  snapshot.summary.runningCount = 12;
  snapshot.summary.relevantCount = 12;

  const streams = [];
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
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, json: async () => snapshot })
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.querySelectorAll('.session-card').length, 12);
  assert.equal(document.querySelectorAll('[data-filter]').length, 0);
  assert.equal(document.querySelectorAll('.live-transcript').length, 12);
  assert.equal(document.querySelector('#connectPanel').classList.contains('hidden'), true);
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"] .live-transcript').textContent, /complete live output/);
  assert.equal(document.querySelectorAll('.transcript-entry').length, 12);

  const changed = structuredClone(snapshot);
  changed.sessions[0].liveOutput = [{ id: 'entry-0', type: 'assistant', ordinal: 2, at: new Date().toISOString(), text: 'word-by-word stream update' }];
  changed.sessions[0].latestItem.text = 'word-by-word stream update';
  changed.sessions[0].latestItem.preview = 'word-by-word stream update';
  changed.sessions[0].outputDigest = 'changed-digest';
  streams[0].listeners.snapshot({ data: JSON.stringify(changed) });
  assert.match(document.querySelector('[data-session-id="synthetic-live-01"]').textContent, /word-by-word stream update/);
  adapter.close();
});

test('hosted shell accepts the private PC access URL and targets the live PC origin', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(root, 'app/public/index.html'), 'utf8'));
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
  assert.match(streams[0].url, /^https:\/\/192\.168\.1\.129:8766\/events\?token=remote-test-token$/);
  assert.equal(document.querySelectorAll('.session-card').length, 12);
  adapter.close();
});
