'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dashboardUrl = process.argv[2] || process.env.MONITOR_BROWSER_URL || 'http://127.0.0.1:8766/';
const root = path.resolve(__dirname, '..');
const dashboardHost = new URL(dashboardUrl).hostname.toLowerCase();
const isPublicShell = !['127.0.0.1', 'localhost', '::1'].includes(dashboardHost);
const screenshotPath = path.join(root, 'data', isPublicShell ? 'browser-global-live-proof.png' : 'browser-live-proof.png');
const monitorConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'monitor.json'), 'utf8'));
const publicEndpoint = isPublicShell
  ? fs.readFileSync(path.join(root, 'data', 'tailscale', 'public-url.txt'), 'utf8').trim().replace(/\/$/, '')
  : '';
const proofToken = isPublicShell ? fs.readFileSync(monitorConfig.auth.tokenFile, 'utf8').trim() : '';
const navigationUrl = isPublicShell
  ? dashboardUrl.replace(/#.*$/, '') + '#' + new URLSearchParams({ token: proofToken, endpoint: publicEndpoint }).toString()
  : dashboardUrl;
const chromeCandidates = [
  process.env.CHROME_PATH,
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].filter(Boolean);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value, spacing) {
  const serialized = JSON.stringify(value, null, spacing);
  return proofToken ? serialized.split(proofToken).join('[redacted]') : serialized;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return await response.json();
      lastError = new Error('HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + url + ': ' + (lastError && lastError.message));
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const openTimeout = setTimeout(() => reject(new Error('Chrome DevTools WebSocket open timed out')), 10000);
      socket.addEventListener('open', () => {
        clearTimeout(openTimeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(openTimeout);
        reject(new Error('Chrome DevTools WebSocket failed'));
      }, { once: true });
      socket.addEventListener('message', async (event) => {
        let raw;
        if (typeof event.data === 'string') raw = event.data;
        else if (event.data && typeof event.data.text === 'function') raw = await event.data.text();
        else raw = Buffer.from(event.data).toString('utf8');
        const message = JSON.parse(raw);
        if (!message.id) {
          this.events.push(message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
      });
      socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools WebSocket closed'));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Chrome DevTools command timed out: ' + method));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + JSON.stringify(result.exceptionDetails));
    return result.result && result.result.value;
  }

  close() {
    if (this.socket && this.socket.readyState < 2) this.socket.close();
  }
}

const pageStateExpression = String.raw`(() => {
  const text = (selector) => (document.querySelector(selector)?.textContent || '').trim();
  const cards = Array.from(document.querySelectorAll('.session-card')).map((card) => ({
    id: card.dataset.sessionId || '',
    title: (card.querySelector('.card-title')?.textContent || '').trim(),
    status: (card.querySelector('.status-pill')?.textContent || '').trim(),
    activity: (card.querySelector('.live-activity-label')?.textContent || '').trim(),
    activityDetail: (card.querySelector('.live-activity-detail')?.textContent || '').trim(),
    transcriptCount: (card.querySelector('.transcript-count')?.textContent || '').trim(),
    transcriptText: (card.querySelector('.transcript-scroll')?.textContent || '').trim(),
    digest: card.dataset.outputDigest || '',
    width: Math.round(card.getBoundingClientRect().width),
    transcriptHeight: Math.round(card.querySelector('.transcript-scroll')?.getBoundingClientRect().height || 0)
  }));
  const error = document.querySelector('#errorNotice');
  const overflows = Array.from(document.querySelectorAll('body *'))
    .filter((element) => element.scrollWidth > element.clientWidth + 2)
    .map((element) => ({
      tag: element.tagName,
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className : '',
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      text: (element.textContent || '').trim().slice(0, 100)
    }))
    .sort((left, right) => right.scrollWidth - left.scrollWidth)
    .slice(0, 12);
  return {
    title: document.title,
    readyState: document.readyState,
    bootstrapPresent: Boolean(window.__CODEX_MONITOR_BOOTSTRAP__ || document.querySelector('#codexMonitorBootstrap')),
    connection: text('#connectionBadge'),
    runningCount: text('#runningCount'),
    statusRunningCount: text('#statusRunningCount'),
    outputCount: text('#outputCount'),
    statusOutputCoverage: text('#statusOutputCoverage'),
    sessionIndex: text('#sessionIndexMeta'),
    lastUpdate: text('#lastUpdate'),
    errorVisible: Boolean(error && getComputedStyle(error).display !== 'none' && !error.hidden),
    errorText: (error?.textContent || '').trim(),
    overlayVisible: Boolean(document.querySelector('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay')),
    bodyChars: (document.body?.innerText || '').trim().length,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement?.scrollWidth || 0,
    overflows,
    cards
  };
})()`;

function signature(state) {
  return JSON.stringify({
    lastUpdate: state.lastUpdate,
    cards: state.cards.map((card) => [card.id, card.digest, card.activity, card.transcriptCount])
  });
}

async function main() {
  const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(chrome, 'Google Chrome was not found');
  const port = await freePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-browser-'));
  const normalizedTemp = path.resolve(tempRoot);
  assert.equal(path.dirname(normalizedTemp), path.resolve(os.tmpdir()), 'Temporary Chrome profile escaped the system temp directory');
  const chromeProcess = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + tempRoot,
    '--window-size=980,1120',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    process.stdout.write('browser-proof: starting Chrome\n');
    await waitForJson('http://127.0.0.1:' + port + '/json/version');
    process.stdout.write('browser-proof: Chrome ready\n');
    const target = await fetch('http://127.0.0.1:' + port + '/json/new', { method: 'PUT' }).then((response) => response.json());
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    process.stdout.write('browser-proof: CDP connected\n');
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
      cdp.send('Log.enable')
    ]);
    const navigationStarted = Date.now();
    await cdp.send('Page.navigate', { url: navigationUrl });
    process.stdout.write('browser-proof: dashboard navigation committed\n');
    let state;
    const firstPaintDeadline = Date.now() + 15000;
    while (Date.now() < firstPaintDeadline) {
      state = await cdp.evaluate(pageStateExpression);
      if (state && state.readyState === 'complete' && state.cards.length > 0 && /^Live/.test(state.connection)) break;
      await delay(100);
    }
    const firstPaintMs = Date.now() - navigationStarted;
    if (!state || state.cards.length === 0) {
      const diagnosticScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(diagnosticScreenshot.data, 'base64'));
      const diagnosticEvents = cdp.events.filter((event) => [
        'Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded',
        'Network.loadingFailed', 'Page.frameStoppedLoading'
      ].includes(event.method));
      process.stderr.write('BROWSER_STATE ' + safeJson(state, 2) + '\n');
      process.stderr.write('BROWSER_EVENTS ' + safeJson(diagnosticEvents, 2) + '\n');
      process.stderr.write('BROWSER_SCREENSHOT ' + screenshotPath + '\n');
    }
    assert.ok(state && state.cards.length > 0, 'Dashboard rendered no running-session cards');
    assert.match(state.connection, /^Live/, 'Dashboard never reached a live connection state');
    assert.ok(firstPaintMs < 6000, 'Dashboard first paint exceeded 6 seconds');

    let snapshot;
    const exactSetDeadline = Date.now() + (isPublicShell ? 30000 : 10000);
    while (Date.now() < exactSetDeadline) {
      const snapshotUrl = isPublicShell ? publicEndpoint + '/api/snapshot' : new URL('/api/snapshot', dashboardUrl);
      const snapshotOptions = { cache: 'no-store' };
      if (isPublicShell) snapshotOptions.headers = { Authorization: 'Bearer ' + proofToken };
      snapshot = await fetch(snapshotUrl, snapshotOptions).then((response) => response.json());
      state = await cdp.evaluate(pageStateExpression);
      const apiIds = snapshot.sessions.map((session) => String(session.id)).sort();
      const cardIds = state.cards.map((card) => String(card.id)).sort();
      const fullyHydrated = state.outputCount === state.cards.length + ' / ' + state.cards.length;
      if (JSON.stringify(apiIds) === JSON.stringify(cardIds) && fullyHydrated) break;
      await delay(200);
    }

    const apiIds = snapshot.sessions.map((session) => String(session.id)).sort();
    const cardIds = state.cards.map((card) => String(card.id)).sort();
    const preflightScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(preflightScreenshot.data, 'base64'));
    process.stdout.write('browser-proof: layout ' + JSON.stringify({
      innerWidth: state.innerWidth,
      scrollWidth: state.scrollWidth,
      runningCount: state.runningCount,
      cardCount: state.cards.length,
      cardWidths: state.cards.map((card) => card.width),
      overflows: state.overflows,
      connection: state.connection,
      screenshotPath
    }) + '\n');
    assert.deepEqual(cardIds, apiIds, 'Rendered card IDs do not exactly match the live snapshot');
    assert.equal(Number(state.runningCount), state.cards.length, 'Running summary does not equal rendered cards');
    assert.equal(Number(state.statusRunningCount), state.cards.length, 'Sticky running count does not equal rendered cards');
    assert.equal(snapshot.summary.runningCount, state.cards.length, 'API running count does not equal rendered cards');
    assert.equal(state.outputCount, state.cards.length + ' / ' + state.cards.length, 'Every remote card was not hydrated with exact output');
    assert.ok(state.cards.every((card) => card.status === 'RUNNING NOW'), 'A non-running card was rendered');
    assert.ok(state.cards.every((card) => card.title && card.activity && card.transcriptText), 'A card is missing readable title, activity, or transcript state');
    assert.equal(new Set(cardIds).size, cardIds.length, 'Duplicate session cards were rendered');
    assert.equal(state.errorVisible, false, 'Dashboard error notice is visible: ' + state.errorText);
    assert.equal(state.overlayVisible, false, 'A framework error overlay is visible');
    assert.ok(state.bodyChars > 500, 'Dashboard body is effectively blank');
    assert.ok(state.scrollWidth <= state.innerWidth + 2, 'Dashboard has horizontal page overflow');
    assert.ok(state.cards.every((card) => card.width >= 360 && card.transcriptHeight >= 80), 'A live card is too narrow or its transcript is collapsed');

    const initialSignature = signature(state);
    process.stdout.write('BROWSER_LIVE_PULSE ' + crypto.randomUUID() + '\n');
    let liveChanged = false;
    const liveDeadline = Date.now() + 15000;
    while (Date.now() < liveDeadline) {
      await delay(250);
      const next = await cdp.evaluate(pageStateExpression);
      if (signature(next) !== initialSignature) {
        state = next;
        liveChanged = true;
        break;
      }
    }
    assert.equal(liveChanged, true, 'Rendered live wall did not change after a live IPC/SSE event');
    assert.match(state.connection, /^Live/, 'Dashboard left the live state during the update check');
    assert.equal(state.errorVisible, false, 'Dashboard showed an error during the live update check');

    const failures = cdp.events.filter((event) => {
      if (event.method === 'Runtime.exceptionThrown') return true;
      if (event.method === 'Inspector.targetCrashed') return true;
      if (event.method === 'Log.entryAdded') return event.params && event.params.entry && event.params.entry.level === 'error';
      if (event.method === 'Runtime.consoleAPICalled') return event.params && event.params.type === 'error';
      if (event.method === 'Network.loadingFailed') return !event.params.canceled;
      return false;
    });
    if (failures.length) {
      const inlineSource = await cdp.evaluate(`Array.from(document.scripts).map((script) => script.textContent || '').find((value) => value.includes('__CODEX_MONITOR_BOOTSTRAP__')) || ''`);
      const compilation = await cdp.send('Runtime.compileScript', {
        expression: inlineSource,
        sourceURL: 'codex-monitor-bootstrap-diagnostic.js',
        persistScript: false
      });
      const details = compilation.exceptionDetails || {};
      const line = Number(details.lineNumber || 0);
      const column = Number(details.columnNumber || 0);
      const lines = String(inlineSource).split(/\r?\n/);
      const sourceLine = lines[line] || '';
      const inlineDiagnostic = {
        length: inlineSource.length,
        line,
        column,
        description: details.exception && details.exception.description || details.text || '',
        snippet: sourceLine.slice(Math.max(0, column - 100), Math.min(sourceLine.length, column + 100)),
        codes: Array.from(sourceLine.slice(Math.max(0, column - 12), Math.min(sourceLine.length, column + 12))).map((character) => character.codePointAt(0))
      };
      process.stderr.write('INLINE_BOOTSTRAP_DIAGNOSTIC ' + JSON.stringify(inlineDiagnostic) + '\n');
    }
    assert.deepEqual(failures, [], 'Browser emitted runtime/network errors: ' + safeJson(failures));

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    process.stdout.write(JSON.stringify({
      ok: true,
      dashboardUrl,
      firstPaintMs,
      revision: snapshot.revision,
      runningCards: state.cards.length,
      exactIds: true,
      onlyRunning: true,
      readableCards: true,
      liveDomChanged: true,
      connection: state.connection,
      outputCoverage: state.outputCount,
      statusOutputCoverage: state.statusOutputCoverage,
      horizontalOverflow: state.scrollWidth > state.innerWidth + 2,
      browserErrors: failures.length,
      screenshotPath,
      cards: state.cards.map((card) => ({
        id: card.id,
        title: card.title,
        activity: card.activity,
        transcriptCount: card.transcriptCount
      }))
    }, null, 2) + '\n');
    try { await cdp.send('Browser.close'); } catch {}
  } finally {
    if (cdp) cdp.close();
    if (!chromeProcess.killed) chromeProcess.kill();
    await delay(250);
    fs.rmSync(normalizedTemp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
