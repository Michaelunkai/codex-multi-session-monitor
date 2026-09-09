'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { execFileSync } = require('node:child_process');

const SERVER_VERSION = '2.0.0';
const DEFAULT_PORT = 8765;
const DEFAULT_POLL_MS = 500;
const DEFAULT_LIVE_WINDOW_SECONDS = 20;
const DEFAULT_ACTIVE_WINDOW_SECONDS = 600;
const DEFAULT_STALE_WINDOW_SECONDS = 1800;
const DEFAULT_ATTENTION_WINDOW_SECONDS = 900;
const DEFAULT_RELEVANT_HOURS = 24;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_LIVE_OUTPUT_CHARS = 5000000;
const STATUS_RANK = Object.freeze({
  ERROR: 0,
  STUCK: 1,
  RUNNING: 2,
  WAITING: 3,
  UNKNOWN: 4,
  COMPLETED: 5,
  INACTIVE: 6
});

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  DatabaseSync = null;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function nonEmpty(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function truncate(value, limit = 240) {
  const text = nonEmpty(value);
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function compactWhitespace(value) {
  return truncate(nonEmpty(value).replace(/\s+/g, ' ').trim(), 220);
}

function redact(value) {
  let text = compactWhitespace(value);
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted]');
  text = text.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return text;
}

function normalizeStatus(value) {
  return nonEmpty(value).toLowerCase().replace(/[_\s-]/g, '');
}

function stripExtendedPrefix(value) {
  const text = nonEmpty(value);
  if (/^\\\\\?\\UNC\\/i.test(text)) return '\\\\' + text.slice(8);
  if (/^\\\\\?\\/i.test(text)) return text.slice(4);
  return text;
}

function safeIso(milliseconds) {
  const value = integer(milliseconds);
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function safeFileMtime(filePath, cache, now) {
  const cleanPath = stripExtendedPrefix(filePath);
  if (!cleanPath) return 0;
  const cached = cache.get(cleanPath);
  // This value gates the running-only decision. Keep it short enough that a
  // newly appended rollout event is reflected on the next monitor tick.
  if (cached && now - cached.checkedAt < 250) return cached.mtimeMs;
  let mtimeMs = 0;
  try {
    mtimeMs = Math.trunc(fs.statSync(cleanPath).mtimeMs);
  } catch {
    mtimeMs = 0;
  }
  cache.set(cleanPath, { checkedAt: now, mtimeMs });
  return mtimeMs;
}

function projectLabel(cwd) {
  const clean = stripExtendedPrefix(cwd).replace(/[\\/]+$/, '');
  if (!clean) return 'Unknown project';
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeOrigin(value) {
  const candidate = nonEmpty(value);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function epochMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 100000000000 ? Math.trunc(number * 1000) : Math.trunc(number);
}

function redactExact(value) {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted]');
  text = text.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*([:=])\s*\S+/gi, '$1$2[redacted]');
  return text;
}

function collectText(value, output = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    if (value.length > 0) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  const preferredKeys = [
    'text', 'output_text', 'content', 'stdout', 'stderr',
    'aggregated_output', 'aggregatedOutput', 'formatted_output',
    'formattedOutput', 'output', 'result', 'message', 'summary_text', 'summary'
  ];
  let found = false;
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    found = true;
    collectText(value[key], output, depth + 1);
  }
  if (!found && (value.type === 'output_text' || value.type === 'input_text') && value.text) {
    collectText(value.text, output, depth + 1);
  }
  return output;
}

function joinText(value) {
  return redactExact(collectText(value).join('\n'));
}

function itemOutputText(item) {
  if (!item || typeof item !== 'object') return '';
  const normalized = normalizeStatus(item.type);
  if (normalized === 'usermessage' || normalized === 'reasoning' || normalized === 'contextcompaction') return '';
  if (normalized === 'agentmessage' || normalized === 'assistant') return joinText(item.content || item.text);
  if (normalized === 'commandexecution') {
    const formatted = nonEmpty(item.formatted_output || item.formattedOutput);
    const aggregate = nonEmpty(item.aggregated_output || item.aggregatedOutput);
    const stdout = item.stdout === null || item.stdout === undefined ? '' : String(item.stdout);
    const stderr = item.stderr === null || item.stderr === undefined ? '' : String(item.stderr);
    let text = formatted || aggregate || stdout;
    if (stderr && stderr !== text && !text.includes(stderr)) text = text ? text + '\n' + stderr : stderr;
    return redactExact(text);
  }
  if (normalized === 'filechange') {
    return joinText(item.stdout || item.stderr || item.status || item.changes);
  }
  return joinText(item.result || item.output || item.content || item.text || item.message || item.results);
}

function responseOutputText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.type === 'message' && payload.role === 'assistant') return joinText(payload.content);
  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
    return joinText(payload.output || payload.result || payload.content);
  }
  return '';
}

function makeLiveEntry(type, id, ordinal, timestampMs, text, source = 'rollout') {
  const value = redactExact(text);
  if (!value) return null;
  return {
    id: nonEmpty(id, source + '-' + String(ordinal)),
    type: nonEmpty(type, 'output'),
    ordinal: integer(ordinal),
    at: safeIso(timestampMs) || null,
    timestampMs: integer(timestampMs),
    text: value,
    source
  };
}

function insertLiveEntry(entries, entry) {
  if (!entry || !entry.text) return;
  const sameId = entry.id && entries.find((candidate) => candidate.id === entry.id);
  if (sameId) {
    if (entry.text.length >= sameId.text.length || sameId.type !== 'assistant') Object.assign(sameId, entry);
    return;
  }
  const duplicateText = entries.find((candidate) => candidate.text === entry.text && Math.abs(candidate.ordinal - entry.ordinal) <= 4);
  if (duplicateText) {
    if (entry.type === 'assistant' || duplicateText.type === 'AgentMessage') Object.assign(duplicateText, entry);
    return;
  }
  entries.push(entry);
}

function rolloutState() {
  return {
    active: false,
    turnId: '',
    startedAtMs: 0,
    lastActivityMs: 0,
    lastOrdinal: 0,
    entries: []
  };
}

function applyRolloutRecord(state, record) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const ordinal = integer(record.ordinal, state.lastOrdinal + 1);
  state.lastOrdinal = Math.max(state.lastOrdinal, ordinal);
  const recordTimestampMs = Date.parse(nonEmpty(record.timestamp)) || 0;
  const payloadTimeMs = Math.max(
    epochMilliseconds(payload.started_at),
    epochMilliseconds(payload.completed_at),
    epochMilliseconds(payload.started_at_ms),
    epochMilliseconds(payload.completed_at_ms),
    recordTimestampMs
  );
  if (payload.type === 'task_started') {
    state.active = true;
    state.turnId = nonEmpty(payload.turn_id || payload.turnId);
    state.startedAtMs = epochMilliseconds(payload.started_at || payload.startedAt || payload.started_at_ms);
    state.lastActivityMs = Math.max(state.startedAtMs, payloadTimeMs);
    state.entries = [];
    return;
  }
  if (payload.type === 'task_complete') {
    const completedTurnId = nonEmpty(payload.turn_id || payload.turnId);
    if (!completedTurnId || completedTurnId === state.turnId) {
      state.active = false;
      state.lastActivityMs = Math.max(state.lastActivityMs, payloadTimeMs);
    }
    return;
  }
  if (!state.active) return;
  const recordTurnId = nonEmpty(payload.turn_id || payload.turnId);
  if (recordTurnId && state.turnId && recordTurnId !== state.turnId) return;
  state.lastActivityMs = Math.max(state.lastActivityMs, payloadTimeMs);
  let entry = null;
  if (payload.type === 'item_completed' && payload.item) {
    const item = payload.item;
    entry = makeLiveEntry(item.type, item.id, ordinal, Math.max(
      epochMilliseconds(payload.completed_at_ms),
      epochMilliseconds(payload.started_at_ms),
      recordTimestampMs
    ), itemOutputText(item), 'rollout');
  } else if (record.type === 'response_item') {
    const output = responseOutputText(payload);
    if (output) {
      const itemType = payload.type === 'message' ? 'assistant' : payload.type;
      entry = makeLiveEntry(itemType, payload.id, ordinal, recordTimestampMs, output, 'rollout');
    }
  }
  if (entry) insertLiveEntry(state.entries, entry);
}

function finalizeRolloutState(state) {
  return {
    active: state.active === true,
    turnId: state.turnId || null,
    startedAtMs: state.startedAtMs || 0,
    lastActivityMs: state.lastActivityMs || 0,
    lastOrdinal: state.lastOrdinal || 0,
    entries: state.entries.slice().sort((a, b) => (a.ordinal - b.ordinal) || (a.timestampMs - b.timestampMs))
  };
}

function parseLiveRollout(text, options = {}) {
  const state = rolloutState();
  const source = String(text || '');
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { applyRolloutRecord(state, JSON.parse(line)); } catch {}
  }
  const parsed = finalizeRolloutState(state);
  const now = integer(options.now, Date.now());
  parsed.ageSeconds = parsed.lastActivityMs ? Math.max(0, (now - parsed.lastActivityMs) / 1000) : null;
  return parsed;
}

function createRolloutTracker() {
  const cache = new Map();

  function readBytes(filePath, start, end) {
    const length = Math.max(0, end - start);
    if (!length) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
    return buffer;
  }

  function applyCompleteBuffer(state, buffer) {
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline < 0) return 0;
    const complete = buffer.subarray(0, lastNewline + 1).toString('utf8');
    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { applyRolloutRecord(state, JSON.parse(line)); } catch {}
    }
    return lastNewline + 1;
  }

  return function read(filePath, now = Date.now()) {
    const cleanPath = stripExtendedPrefix(filePath);
    if (!cleanPath) return { active: false, error: 'rollout path missing' };
    let stat;
    try { stat = fs.statSync(cleanPath); } catch { return { active: false, error: 'rollout file unavailable' }; }
    const size = Math.trunc(stat.size);
    const mtimeMs = Math.trunc(stat.mtimeMs);
    const previous = cache.get(cleanPath);
    let state;
    let parsedBytes;
    const reset = !previous || size < previous.size || mtimeMs < previous.mtimeMs || size === previous.size && mtimeMs !== previous.mtimeMs;
    try {
      if (reset) {
        state = rolloutState();
        const full = fs.readFileSync(cleanPath);
        parsedBytes = applyCompleteBuffer(state, full);
      } else {
        state = previous.state;
        parsedBytes = previous.parsedBytes;
        if (size > parsedBytes) {
          const chunk = readBytes(cleanPath, parsedBytes, size);
          parsedBytes += applyCompleteBuffer(state, chunk);
        }
      }
      const result = finalizeRolloutState(state);
      result.rolloutMtimeMs = mtimeMs;
      result.rolloutSize = size;
      result.ageSeconds = result.lastActivityMs ? Math.max(0, (now - result.lastActivityMs) / 1000) : null;
      cache.set(cleanPath, { size, mtimeMs, parsedBytes, state });
      return result;
    } catch (error) {
      return { active: false, error: 'rollout read failed: ' + truncate(error.message, 140), rolloutMtimeMs: mtimeMs, rolloutSize: size };
    }
  };
}

function classifyLiveSession(telemetry, now, config) {
  const liveWindowSeconds = Math.max(3, integer(config && config.liveWindowSeconds, DEFAULT_LIVE_WINDOW_SECONDS));
  const lastActivityMs = Math.max(integer(telemetry && telemetry.lastActivityMs), integer(telemetry && telemetry.rolloutMtimeMs));
  const ageSeconds = lastActivityMs ? Math.max(0, (now - lastActivityMs) / 1000) : Number.POSITIVE_INFINITY;
  const eligible = Boolean(telemetry && telemetry.active && telemetry.turnId && lastActivityMs && ageSeconds <= liveWindowSeconds);
  if (eligible) {
    return {
      status: 'RUNNING',
      statusRank: STATUS_RANK.RUNNING,
      attention: false,
      reliability: 'direct rollout task_started + no task_complete + fresh write',
      reason: 'Codex has an unfinished rollout turn with a fresh local event.',
      rawStatus: 'inProgress',
      lastActivityMs,
      ageSeconds: Math.round(ageSeconds * 10) / 10,
      elapsedSeconds: telemetry.startedAtMs ? Math.max(0, Math.round((now - telemetry.startedAtMs) / 100) / 10) : null
    };
  }
  return {
    status: 'INACTIVE',
    statusRank: STATUS_RANK.INACTIVE,
    attention: false,
    reliability: telemetry && telemetry.active ? 'direct rollout status + stale write' : 'no unfinished rollout turn',
    reason: telemetry && telemetry.active
      ? 'The rollout is not displayed until a fresh local event is observed.'
      : 'The rollout has completed or no active rollout turn was found.',
    rawStatus: 'none',
    lastActivityMs: lastActivityMs || 0,
    ageSeconds: Number.isFinite(ageSeconds) ? Math.round(ageSeconds * 10) / 10 : null,
    elapsedSeconds: null
  };
}

function sourceLabel(source, threadSource, agentNickname) {
  const raw = nonEmpty(source);
  const parsed = raw.startsWith('{') ? parseJson(raw, null) : null;
  if (parsed && parsed.subagent) {
    const nested = parsed.subagent.thread_spawn || parsed.subagent.other || {};
    const nick = nonEmpty(agentNickname || nested.agent_nickname);
    return nick ? 'Codex subagent · ' + nick : 'Codex subagent';
  }
  if (raw === 'vscode') return threadSource === 'user' ? 'Codex local · VS Code-origin' : 'Codex · VS Code';
  if (raw === 'cli') return 'Codex CLI';
  if (raw === 'exec') return 'Codex exec';
  if (raw === 'voice_chat') return 'Codex voice';
  if (raw) return 'Codex · ' + truncate(raw, 48);
  return 'Codex local';
}

function flattenText(value, output = [], depth = 0) {
  if (depth > 4 || output.join(' ').length > 700) return output;
  if (typeof value === 'string') {
    if (value.trim()) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, output, depth + 1);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const preferredKeys = ['text', 'summary', 'last_agent_message', 'aggregatedOutput', 'aggregated_output', 'output', 'message', 'content', 'command', 'command_line'];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) flattenText(value[key], output, depth + 1);
  }
  if (output.length === 0 && Object.prototype.hasOwnProperty.call(value, 'type')) {
    output.push(String(value.type));
  }
  return output;
}

function itemPreview(itemType, rawJson) {
  const parsed = parseJson(rawJson, null);
  if (!parsed) return { type: nonEmpty(itemType, 'item'), preview: redact(rawJson) };
  const type = nonEmpty(parsed.type || itemType, 'item');
  const pieces = [];
  const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
  const candidates = [
    parsed.text,
    parsed.summary,
    parsed.last_agent_message,
    parsed.aggregatedOutput,
    parsed.aggregated_output,
    parsed.output,
    parsed.type === 'mcpToolCall' ? [parsed.server, parsed.tool, parsed.status].filter(Boolean).join(' · ') : null,
    parsed.result && parsed.result.content,
    parsed.command,
    parsed.command_line,
    parsed.error && parsed.error.message,
    payload && payload.last_agent_message,
    payload && payload.type,
    parsed.message && parsed.message.content,
    parsed.content
  ];
  for (const candidate of candidates) flattenText(candidate, pieces);
  const preview = redact(pieces.filter(Boolean).join(' · '));
  return {
    type,
    preview: preview || type,
    rawType: nonEmpty(itemType, type),
    parsed
  };
}

function progressFromItem(item) {
  const parsed = item && item.parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const plan = parsed.plan || parsed.turn_plan || parsed.payload && parsed.payload.plan;
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const completed = plan.filter((entry) => normalizeStatus(entry && entry.status) === 'completed').length;
  const current = plan.find((entry) => normalizeStatus(entry && entry.status) === 'inprogress');
  return {
    completed,
    total: plan.length,
    current: current ? truncate(current.step || current.name || '', 120) : null
  };
}

function classifySession(meta, turn, detail, now, config) {
  const stateUpdatedMs = integer(meta.updatedAtMs);
  const turnStartedMs = integer(turn && turn.startedAtMs);
  const turnCompletedMs = integer(turn && turn.completedAtMs);
  const itemUpdatedMs = integer(detail && detail.latestItemMs);
  const rolloutMtimeMs = integer(detail && detail.rolloutMtimeMs);
  const lastActivityMs = Math.max(stateUpdatedMs, turnStartedMs, turnCompletedMs, itemUpdatedMs, rolloutMtimeMs);
  const ageSeconds = lastActivityMs ? Math.max(0, (now - lastActivityMs) / 1000) : Number.POSITIVE_INFINITY;
  const rawStatus = normalizeStatus(turn && turn.status);
  let status = 'UNKNOWN';
  let reliability = 'heuristic';
  let reason = 'No current turn status was available.';

  if (rawStatus === 'inprogress' || rawStatus === 'running' || rawStatus === 'active') {
    reliability = ageSeconds <= config.activeWindowSeconds ? 'direct status + fresh write' : 'direct status + stale write';
    if (ageSeconds <= config.activeWindowSeconds) {
      status = 'RUNNING';
      reason = 'Codex reports an in-progress turn and the local record is fresh.';
    } else if (ageSeconds <= config.staleWindowSeconds) {
      status = 'STUCK';
      reason = 'The latest turn is still marked in progress, but no fresh local write was observed.';
    } else {
      status = 'INACTIVE';
      reason = 'An old in-progress record remains without fresh local activity; this is not called running.';
    }
  } else if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'systemerror') {
    status = 'ERROR';
    reliability = 'direct persisted turn status';
    reason = 'Codex persisted a failed/error turn.';
  } else if (rawStatus === 'interrupted' || rawStatus === 'aborted' || rawStatus === 'cancelled') {
    if (ageSeconds <= config.attentionWindowSeconds) {
      status = 'WAITING';
      reliability = 'direct turn status + attention heuristic';
      reason = 'The latest turn stopped before completion; review or resume may be needed.';
    } else {
      status = 'INACTIVE';
      reliability = 'direct persisted turn status';
      reason = 'The latest turn was interrupted and is no longer recent.';
    }
  } else if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'done') {
    if (ageSeconds <= config.attentionWindowSeconds) {
      status = 'WAITING';
      reliability = 'direct completed status + attention heuristic';
      reason = 'A turn completed recently; the conversation may be waiting for review or input.';
    } else if (ageSeconds <= config.relevantHours * 3600) {
      status = 'COMPLETED';
      reliability = 'direct persisted turn status';
      reason = 'The latest persisted turn completed.';
    } else {
      status = 'INACTIVE';
      reliability = 'direct persisted turn status + age';
      reason = 'The latest persisted turn completed but is outside the relevant activity window.';
    }
  } else if (rawStatus === 'pending' || rawStatus === 'queued') {
    status = ageSeconds <= config.staleWindowSeconds ? 'WAITING' : 'INACTIVE';
    reliability = 'direct pending status + age';
    reason = status === 'WAITING' ? 'Codex reports a queued/pending turn.' : 'An old queued/pending record was found.';
  } else if (!turn) {
    status = ageSeconds <= config.relevantHours * 3600 ? 'UNKNOWN' : 'INACTIVE';
    reliability = 'no latest turn status';
    reason = status === 'UNKNOWN' ? 'The session is recent but no latest turn row was found.' : 'No latest turn row is available.';
  } else if (ageSeconds <= config.relevantHours * 3600) {
    status = 'UNKNOWN';
    reliability = 'unrecognized persisted turn status';
    reason = 'A recent turn has an unrecognized status: ' + truncate(turn.status, 48);
  } else {
    status = 'INACTIVE';
    reliability = 'unrecognized persisted turn status + age';
    reason = 'An old turn has an unrecognized status.';
  }

  const elapsedSeconds = rawStatus === 'inprogress' && turnStartedMs
    ? Math.max(0, (now - turnStartedMs) / 1000)
    : integer(turn && turn.durationMs) > 0 ? integer(turn.durationMs) / 1000 : null;
  return {
    status,
    statusRank: STATUS_RANK[status] ?? STATUS_RANK.UNKNOWN,
    attention: ['WAITING', 'ERROR', 'STUCK'].includes(status),
    reliability,
    reason,
    rawStatus: nonEmpty(turn && turn.status, 'none'),
    lastActivityMs,
    ageSeconds: Number.isFinite(ageSeconds) ? Math.round(ageSeconds * 10) / 10 : null,
    elapsedSeconds: elapsedSeconds === null ? null : Math.round(elapsedSeconds * 10) / 10
  };
}

function readCodexDesktopProcess() {
  if (process.platform !== 'win32') return { available: false, count: null };
  try {
    const tasklistPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tasklist.exe');
    const output = execFileSync(tasklistPath, ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1000
    });
    const lines = output.split(/\r?\n/).filter((line) => line.includes('"ChatGPT.exe"'));
    return { available: true, count: lines.length, running: lines.length > 0 };
  } catch {
    return { available: false, count: null };
  }
}

function stableDigest(snapshot) {
  const sessions = snapshot.sessions || [];
  const compact = {
    source: snapshot.source,
    statusCounts: snapshot.summary && snapshot.summary.statusCounts,
    sessions: sessions.map((session) => ({
      id: session.id,
      status: session.status,
      lastActivityAt: session.lastActivityAt,
      latestTurnId: session.latestTurnId,
      outputDigest: session.outputDigest,
      outputChars: session.outputChars,
      outputTruncated: session.outputTruncated,
      progress: session.progress
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(compact)).digest('hex');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function loadJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function normalizeConfig(input, root) {
  const config = input || {};
  const paths = config.paths || {};
  const stateDb = stripExtendedPrefix(nonEmpty(paths.stateDb, path.join(process.env.USERPROFILE || '', '.codex', 'state_5.sqlite')));
  const historyDb = stripExtendedPrefix(nonEmpty(paths.historyDb, path.join(process.env.USERPROFILE || '', '.codex', 'thread_history_1.sqlite')));
  const sessionIndex = stripExtendedPrefix(nonEmpty(paths.sessionIndex, path.join(process.env.USERPROFILE || '', '.codex', 'session_index.jsonl')));
  const tokenFile = stripExtendedPrefix(nonEmpty((config.auth || {}).tokenFile, path.join(root, 'config', 'access.token')));
  const tls = config.tls || {};
  const corsOrigins = Array.isArray(config.corsOrigins)
    ? config.corsOrigins.map(normalizeOrigin).filter(Boolean)
    : [];
  return {
    root,
    bindHost: nonEmpty(config.bindHost, '127.0.0.1'),
    port: integer(config.port, DEFAULT_PORT),
    pollMs: Math.max(250, integer(config.pollMs, DEFAULT_POLL_MS)),
    liveWindowSeconds: Math.max(3, integer(config.liveWindowSeconds, DEFAULT_LIVE_WINDOW_SECONDS)),
    activeWindowSeconds: Math.max(10, integer(config.activeWindowSeconds, DEFAULT_ACTIVE_WINDOW_SECONDS)),
    staleWindowSeconds: Math.max(60, integer(config.staleWindowSeconds, DEFAULT_STALE_WINDOW_SECONDS)),
    attentionWindowSeconds: Math.max(30, integer(config.attentionWindowSeconds, DEFAULT_ATTENTION_WINDOW_SECONDS)),
    relevantHours: Math.max(1, integer(config.relevantHours, DEFAULT_RELEVANT_HOURS)),
    maxSessions: Math.max(10, integer(config.maxSessions, DEFAULT_MAX_SESSIONS)),
    maxLiveOutputChars: Math.max(10000, integer(config.maxLiveOutputChars, DEFAULT_MAX_LIVE_OUTPUT_CHARS)),
    corsOrigins: Array.from(new Set(corsOrigins)),
    paths: { stateDb, historyDb, sessionIndex },
    auth: {
      required: config.auth && config.auth.required !== undefined ? Boolean(config.auth.required) : true,
      tokenFile
    },
    tls: {
      enabled: tls.enabled !== false,
      keyFile: stripExtendedPrefix(nonEmpty(tls.keyFile, path.join(root, 'config', 'tls', 'server-key.pem'))),
      certFile: stripExtendedPrefix(nonEmpty(tls.certFile, path.join(root, 'config', 'tls', 'server-cert.pem')))
    }
  };
}

function readToken(config) {
  if (!config.auth.required) return '';
  try {
    const token = fs.readFileSync(config.auth.tokenFile, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {
    return '';
  }
  return '';
}

function createLiveAdapter(config, syntheticFile = '') {
  let stateDb = null;
  let historyDb = null;
  let indexSignature = '';
  let indexMap = new Map();
  const detailCache = new Map();
  const mtimeCache = new Map();
  const rolloutTracker = createRolloutTracker();
  let lastErrors = [];

  function openDb(current, filePath) {
    if (!DatabaseSync) throw new Error('node:sqlite is unavailable in this Node runtime.');
    if (current) return current;
    return new DatabaseSync(filePath, { readOnly: true });
  }

  function refreshIndex() {
    let stat;
    try {
      stat = fs.statSync(config.paths.sessionIndex);
    } catch {
      return;
    }
    const signature = String(Math.trunc(stat.mtimeMs)) + ':' + String(stat.size);
    if (signature === indexSignature) return;
    const next = new Map();
    try {
      const lines = fs.readFileSync(config.paths.sessionIndex, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = parseJson(line, null);
        if (!record || !record.id) continue;
        const name = nonEmpty(record.thread_name || record.threadName || record.name || record.title);
        if (name) next.set(String(record.id), name);
      }
      indexMap = next;
      indexSignature = signature;
    } catch {
      lastErrors.push('session_index.jsonl read failed');
    }
  }

  function queryState() {
    stateDb = openDb(stateDb, config.paths.stateDb);
    const sql = [
      'SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived,',
      ' first_user_message, agent_nickname, agent_role, model, created_at_ms, updated_at_ms,',
      ' thread_source, preview, recency_at_ms, name, project_id',
      ' FROM threads WHERE archived = 0',
      ' ORDER BY CAST(COALESCE(updated_at_ms, 0) AS INTEGER) DESC'
    ].join(' ');
    return stateDb.prepare(sql).all();
  }

  function queryTurns() {
    historyDb = openDb(historyDb, config.paths.historyDb);
    const latestSql = [
      'SELECT t.thread_id, t.turn_id, t.status, t.started_at, t.completed_at, t.duration_ms,',
      ' t.error_json, t.first_user_item_id, t.final_agent_item_id',
      ' FROM thread_turns t',
      ' INNER JOIN (SELECT thread_id, MAX(rowid) AS latest_rowid FROM thread_turns GROUP BY thread_id) latest',
      ' ON latest.thread_id = t.thread_id AND latest.latest_rowid = t.rowid'
    ].join(' ');
    const turns = new Map();
    for (const row of historyDb.prepare(latestSql).all()) {
      turns.set(String(row.thread_id), {
        id: String(row.turn_id || ''),
        status: row.status,
        startedAtMs: integer(row.started_at) * 1000,
        completedAtMs: integer(row.completed_at) * 1000,
        durationMs: integer(row.duration_ms),
        error: parseJson(row.error_json, null),
        firstUserItemId: nonEmpty(row.first_user_item_id),
        finalAgentItemId: nonEmpty(row.final_agent_item_id)
      });
    }
    const counts = new Map();
    for (const row of historyDb.prepare('SELECT thread_id, COUNT(*) AS count FROM thread_turns GROUP BY thread_id').all()) {
      counts.set(String(row.thread_id), integer(row.count));
    }
    return { turns, counts };
  }

  function queryDetail(threadId, turnId, rolloutPath, stateUpdatedMs, rolloutTelemetry) {
    const rolloutMtimeMs = integer(rolloutTelemetry && rolloutTelemetry.rolloutMtimeMs);
    const cacheKey = [
      String(stateUpdatedMs), String(turnId), String(rolloutMtimeMs),
      String(rolloutTelemetry && rolloutTelemetry.lastOrdinal),
      String(rolloutTelemetry && rolloutTelemetry.entries && rolloutTelemetry.entries.length)
    ].join(':');
    const cached = detailCache.get(threadId);
    if (cached && cached.key === cacheKey) return cached.value;
    const fallback = {
      latestItemMs: 0,
      rolloutMtimeMs,
      latestItem: null,
      progress: null,
      liveOutput: [],
      outputDigest: '',
      outputChars: 0,
      outputTruncated: false
    };
    const entries = [];
    for (const entry of (rolloutTelemetry && rolloutTelemetry.entries) || []) insertLiveEntry(entries, entry);
    const progressItems = [];
    if (historyDb && turnId) {
      try {
        const rows = historyDb.prepare([
          'SELECT item_type, item_json, created_at_ms, rollout_ordinal',
          ' FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY rowid ASC LIMIT 2000'
        ].join(' ')).all(threadId, String(turnId));
        for (const row of rows) {
          const parsed = parseJson(row.item_json, null);
          if (!parsed) continue;
          const item = { ...parsed, type: parsed.type || row.item_type };
          progressItems.push({ parsed: item });
          const text = itemOutputText(item);
          if (!text) continue;
          insertLiveEntry(entries, makeLiveEntry(
            item.type,
            item.id,
            integer(row.rollout_ordinal),
            integer(row.created_at_ms),
            text,
            'thread_items'
          ));
        }
      } catch (error) {
        lastErrors.push('thread_items read failed for ' + threadId);
      }
    }
    entries.sort((a, b) => (a.ordinal - b.ordinal) || (a.timestampMs - b.timestampMs));
    const liveOutput = [];
    let outputChars = 0;
    let outputTruncated = false;
    for (const entry of entries) {
      const remaining = config.maxLiveOutputChars - outputChars;
      if (remaining <= 0) {
        outputTruncated = true;
        break;
      }
      if (entry.text.length <= remaining) {
        liveOutput.push(entry);
        outputChars += entry.text.length;
      } else {
        liveOutput.push({ ...entry, text: entry.text.slice(0, remaining), truncated: true });
        outputChars += remaining;
        outputTruncated = true;
        break;
      }
    }
    const latest = liveOutput.length ? liveOutput[liveOutput.length - 1] : null;
    const outputDigest = crypto.createHash('sha256').update(JSON.stringify(liveOutput.map((entry) => [entry.id, entry.ordinal, entry.text]))).digest('hex');
    const latestItemMs = Math.max(
      ...liveOutput.map((entry) => integer(entry.timestampMs)),
      integer(rolloutTelemetry && rolloutTelemetry.lastActivityMs),
      0
    );
    const value = {
      latestItemMs,
      rolloutMtimeMs,
      latestItem: latest ? {
        type: truncate(latest.type, 64),
        preview: truncate(latest.text, 320),
        text: latest.text,
        at: latest.at
      } : null,
      progress: progressItems.map(progressFromItem).find(Boolean) || null,
      liveOutput,
      outputDigest,
      outputChars,
      outputTruncated
    };
    detailCache.set(threadId, { key: cacheKey, value });
    return value;
  }

  function syntheticSnapshot(now) {
    const fixture = loadJsonFile(syntheticFile, { sessions: [] });
    const rawSessions = Array.isArray(fixture) ? fixture : Array.isArray(fixture.sessions) ? fixture.sessions : [];
    const sessions = rawSessions.map((raw, index) => {
      const status = nonEmpty(raw.status, 'UNKNOWN').toUpperCase();
      if (status !== 'RUNNING') return null;
      const lastActivityAt = raw.lastActivityAt || safeIso(integer(raw.lastActivityMs, now));
      const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) || now : now;
      const liveOutput = Array.isArray(raw.liveOutput)
        ? raw.liveOutput.map((entry, entryIndex) => ({
          id: nonEmpty(entry && entry.id, 'synthetic-' + (index + 1) + '-output-' + (entryIndex + 1)),
          type: nonEmpty(entry && entry.type, 'synthetic'),
          ordinal: integer(entry && entry.ordinal, entryIndex + 1),
          at: entry && entry.at ? entry.at : safeIso(lastActivityMs),
          timestampMs: integer(entry && entry.timestampMs, lastActivityMs),
          text: redactExact(entry && entry.text),
          source: 'synthetic-test'
        })).filter((entry) => entry.text)
        : raw.latestOutput ? [makeLiveEntry('synthetic', 'synthetic-' + (index + 1) + '-output-1', 1, lastActivityMs, raw.latestOutput, 'synthetic-test')] : [];
      const latest = liveOutput.length ? liveOutput[liveOutput.length - 1] : null;
      return {
        id: nonEmpty(raw.id, 'synthetic-' + (index + 1)),
        title: truncate(nonEmpty(raw.title, 'Synthetic session ' + (index + 1)), 180),
        source: 'synthetic-test',
        sourceLabel: 'Synthetic test fixture',
        threadSource: 'test',
        model: nonEmpty(raw.model, 'test-model'),
        cwd: nonEmpty(raw.cwd, 'F:\\\\synthetic\\\\session-' + (index + 1)),
        project: nonEmpty(raw.project, 'synthetic'),
        projectId: null,
        sessionPath: null,
        status: 'RUNNING',
        statusReliability: 'synthetic test fixture',
        attention: false,
        reason: 'Synthetic unfinished rollout fixture.',
        rawTurnStatus: 'inProgress',
        lastActivityAt: safeIso(lastActivityMs),
        lastActivityAgeSeconds: Math.max(0, Math.round((now - lastActivityMs) / 100) / 10),
        elapsedSeconds: raw.elapsedSeconds == null ? null : Number(raw.elapsedSeconds),
        latestTurnId: nonEmpty(raw.latestTurnId, 'synthetic-turn-' + (index + 1)),
        latestTurnStatus: 'inProgress',
        latestTurnStartedAt: safeIso(integer(raw.latestTurnStartedMs, lastActivityMs)),
        turnCount: integer(raw.turnCount, 1),
        latestItem: latest ? { type: latest.type, preview: truncate(latest.text, 320), text: latest.text, at: latest.at } : null,
        liveOutput,
        outputDigest: crypto.createHash('sha256').update(JSON.stringify(liveOutput)).digest('hex'),
        outputChars: liveOutput.reduce((total, entry) => total + entry.text.length, 0),
        outputTruncated: false,
        progress: raw.progress || null,
        archived: false,
        synthetic: true,
        relevant: true
      };
    }).filter(Boolean);
    const statusCounts = {};
    for (const session of sessions) statusCounts[session.status] = (statusCounts[session.status] || 0) + 1;
    sessions.sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
    return {
      schemaVersion: 1,
      serverVersion: SERVER_VERSION,
      source: 'synthetic-test',
      generatedAt: new Date(now).toISOString(),
      summary: {
        totalNonArchived: rawSessions.length,
        relevantCount: sessions.length,
        runningCount: sessions.length,
        hiddenNonRunningCount: rawSessions.length - sessions.length,
        statusCounts,
        sourceCounts: { 'synthetic-test': sessions.length },
        readOnly: true,
        readErrors: [],
        codexDesktop: { available: false, count: null, running: false },
        freshnessSeconds: 0,
        liveWindowSeconds: 20,
        pollMs: 250,
        outputTransport: 'synthetic fixture'
      },
      sessions,
      allSessions: sessions
    };
  }

  function snapshot() {
    const now = Date.now();
    lastErrors = [];
    if (syntheticFile) return syntheticSnapshot(now);
    refreshIndex();
    let stateRows;
    let turnData;
    try {
      stateRows = queryState();
    } catch (error) {
      lastErrors.push('state_5.sqlite read failed: ' + truncate(error.message, 140));
      stateRows = [];
    }
    try {
      turnData = queryTurns();
    } catch (error) {
      lastErrors.push('thread_history_1.sqlite read failed: ' + truncate(error.message, 140));
      turnData = { turns: new Map(), counts: new Map() };
    }
    const runningSessions = [];
    let persistedInProgressCount = 0;
    let activeRolloutCount = 0;
    let telemetryErrorCount = 0;
    for (const row of stateRows) {
      const id = String(row.id);
      const turn = turnData.turns.get(id) || null;
      const meta = {
        id,
        title: nonEmpty(row.title || row.name || row.first_user_message, 'Untitled Codex session'),
        name: nonEmpty(row.name),
        cwd: stripExtendedPrefix(row.cwd),
        source: nonEmpty(row.source),
        threadSource: nonEmpty(row.thread_source),
        agentNickname: nonEmpty(row.agent_nickname),
        model: nonEmpty(row.model || row.model_provider, 'unknown'),
        rolloutPath: stripExtendedPrefix(row.rollout_path),
        updatedAtMs: integer(row.updated_at_ms) || integer(row.updated_at) * 1000,
        projectId: nonEmpty(row.project_id) || null
      };
      if (normalizeStatus(turn && turn.status) === 'inprogress') persistedInProgressCount += 1;
      const rolloutMtimeMs = safeFileMtime(meta.rolloutPath, mtimeCache, now);
      const rolloutFresh = rolloutMtimeMs > 0 && now - rolloutMtimeMs <= (config.liveWindowSeconds + 5) * 1000;
      const shouldInspectRollout = normalizeStatus(turn && turn.status) === 'inprogress' ||
        now - meta.updatedAtMs <= (config.liveWindowSeconds + 5) * 1000 || rolloutFresh;
      const telemetry = shouldInspectRollout
        ? rolloutTracker(meta.rolloutPath, now)
        : { active: false, lastActivityMs: 0, rolloutMtimeMs };
      telemetry.rolloutMtimeMs = Math.max(integer(telemetry.rolloutMtimeMs), rolloutMtimeMs);
      if (telemetry.active) activeRolloutCount += 1;
      if (telemetry.error) telemetryErrorCount += 1;
      const classification = classifyLiveSession(telemetry, now, config);
      if (classification.status !== 'RUNNING') continue;
      const indexedTitle = indexMap.get(id);
      const title = truncate(compactWhitespace(indexedTitle || meta.title), 180);
      const liveTurnId = telemetry.turnId || (turn && turn.id) || null;
      const detail = queryDetail(id, liveTurnId, meta.rolloutPath, meta.updatedAtMs, telemetry);
      const latestItem = detail.latestItem || null;
      const session = {
        id,
        title,
        source: meta.source || 'unknown',
        sourceLabel: sourceLabel(meta.source, meta.threadSource, meta.agentNickname),
        threadSource: meta.threadSource || 'unknown',
        model: truncate(meta.model, 80),
        cwd: meta.cwd || 'Unknown working directory',
        project: projectLabel(meta.cwd),
        projectId: meta.projectId,
        sessionPath: meta.rolloutPath || null,
        status: classification.status,
        statusReliability: classification.reliability,
        attention: classification.attention,
        reason: classification.reason,
        rawTurnStatus: classification.rawStatus,
        latestTurnId: liveTurnId,
        latestTurnStatus: 'inProgress',
        latestTurnStartedAt: safeIso(telemetry.startedAtMs || turn && turn.startedAtMs),
        latestTurnCompletedAt: null,
        turnCount: turnData.counts.get(id) || 0,
        lastActivityAt: safeIso(classification.lastActivityMs),
        lastActivityAgeSeconds: classification.ageSeconds,
        elapsedSeconds: classification.elapsedSeconds,
        latestItem,
        liveOutput: detail.liveOutput,
        outputDigest: detail.outputDigest,
        outputChars: detail.outputChars,
        outputTruncated: detail.outputTruncated,
        progress: detail.progress || null,
        archived: false,
        synthetic: false,
        relevant: true
      };
      runningSessions.push(session);
    }
    runningSessions.sort((a, b) => {
      return String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''));
    });
    const sessions = runningSessions.slice(0, config.maxSessions);
    const statusCounts = { RUNNING: sessions.length };
    const sourceCounts = {};
    for (const session of sessions) sourceCounts[session.sourceLabel] = (sourceCounts[session.sourceLabel] || 0) + 1;
    return {
      schemaVersion: 1,
      serverVersion: SERVER_VERSION,
      source: 'codex-local-rollout-read-only',
      generatedAt: new Date(now).toISOString(),
      summary: {
        totalNonArchived: stateRows.length,
        relevantCount: sessions.length,
        runningCount: sessions.length,
        persistedInProgressCount,
        activeRolloutCount,
        hiddenNonRunningCount: Math.max(0, stateRows.length - sessions.length),
        telemetryErrorCount,
        statusCounts,
        sourceCounts,
        readOnly: true,
        readErrors: lastErrors.slice(0, 8),
        codexDesktop: readCodexDesktopProcess(),
        freshnessSeconds: sessions.length ? Math.round(Math.min(...sessions.map((session) => session.lastActivityAgeSeconds ?? 999999))) : null,
        liveWindowSeconds: config.liveWindowSeconds,
        pollMs: config.pollMs,
        displayMode: 'running-only',
        outputTransport: 'Codex rollout event records'
      },
      sessions,
      allSessions: sessions
    };
  }

  return {
    snapshot,
    close() {
      try { if (stateDb) stateDb.close(); } catch {}
      try { if (historyDb) historyDb.close(); } catch {}
      stateDb = null;
      historyDb = null;
    }
  };
}

function publicSnapshot(internal, scope) {
  return {
    schemaVersion: internal.schemaVersion,
    serverVersion: internal.serverVersion,
    source: internal.source,
    scope: 'running-now',
    displayMode: 'running-only',
    generatedAt: internal.generatedAt,
    summary: internal.summary,
    sessions: internal.sessions || []
  };
}

function authMatches(request, url, expectedToken, required) {
  if (!required) return true;
  const header = nonEmpty(request.headers.authorization);
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const supplied = bearer ? bearer[1].trim() : nonEmpty(url.searchParams.get('token'));
  if (!supplied || !expectedToken) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function jsonResponse(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function setCorsHeaders(response, request, config) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin || !config.corsOrigins.includes(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Cache-Control');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Vary', 'Origin');
  return true;
}

function staticResponse(response, fileName) {
  const root = path.join(__dirname, 'public');
  const allowed = new Map([
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']]
  ]);
  const selected = allowed.get(fileName) || allowed.get('/index.html');
  try {
    const body = fs.readFileSync(path.join(root, selected[0]));
    response.writeHead(200, {
      'Content-Type': selected[1],
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'Content-Length': body.length
    });
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end('Dashboard asset missing.');
  }
}

function startServer(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const configPath = options.configPath || path.join(root, 'config', 'monitor.json');
  const loaded = options.config || loadJsonFile(configPath, {});
  const config = normalizeConfig(loaded, root);
  const syntheticFile = options.syntheticFile || process.env.MONITOR_SYNTHETIC_FILE || '';
  const token = options.token !== undefined ? options.token : readToken(config);
  if (config.auth.required && !token) {
    throw new Error('Access token is missing or shorter than 32 characters: ' + config.auth.tokenFile);
  }
  if (config.tls.enabled && (!fs.existsSync(config.tls.keyFile) || !fs.existsSync(config.tls.certFile))) {
    throw new Error('TLS certificate files are missing: ' + config.tls.certFile);
  }
  ensureDirectory(path.join(root, 'data'));
  const adapter = createLiveAdapter(config, syntheticFile);
  const subscribers = new Set();
  let lastInternal = null;
  let lastSignature = '';
  let cacheAt = 0;
  let server;
  let pollTimer;
  let heartbeatTimer;

  function getInternal() {
    const now = Date.now();
    if (!lastInternal || now - cacheAt >= Math.min(config.pollMs, 1200)) {
      lastInternal = adapter.snapshot();
      cacheAt = now;
    }
    return lastInternal;
  }

  function getSnapshot(scope = 'relevant') {
    return publicSnapshot(getInternal(), scope);
  }

  function emitSnapshot(force = false) {
    const internal = getInternal();
    const signature = stableDigest(internal);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    for (const subscriber of subscribers) {
      try {
        subscriber.response.write('event: snapshot\n');
        subscriber.response.write('data: ' + JSON.stringify(publicSnapshot(internal, subscriber.scope)) + '\n\n');
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }

  function healthBody() {
    const snapshot = getSnapshot('relevant');
    return {
      ok: snapshot.summary.readErrors.length === 0 && snapshot.summary.readOnly === true,
      serverVersion: SERVER_VERSION,
      protocol: config.tls.enabled ? 'https' : 'http',
      bindHost: config.bindHost,
      port: server && server.address() && server.address().port ? server.address().port : config.port,
      generatedAt: snapshot.generatedAt,
      source: snapshot.source,
      summary: snapshot.summary,
      storage: {
        projectRoot: root,
        stateDb: config.paths.stateDb,
        historyDb: config.paths.historyDb,
        sessionIndex: config.paths.sessionIndex,
        readOnly: true
      }
    };
  }

  function requestHandler(request, response) {
    let url;
    try {
      url = new URL(request.url || '/', 'http://codex-monitor.invalid');
    } catch {
      jsonResponse(response, 400, { error: 'Bad request URL.' });
      return;
    }
    const corsAllowed = setCorsHeaders(response, request, config);
    if (request.method === 'OPTIONS') {
      if (!corsAllowed || !['/api/health', '/api/snapshot', '/events'].includes(url.pathname)) {
        response.writeHead(403, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      jsonResponse(response, 405, { error: 'GET only.' });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.js' || url.pathname === '/styles.css') {
      staticResponse(response, url.pathname);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/health' || url.pathname === '/api/snapshot' || url.pathname === '/events') {
      if (!authMatches(request, url, token, config.auth.required)) {
        jsonResponse(response, 401, { error: 'Authentication required.' });
        return;
      }
      if (url.pathname === '/api/health') {
        jsonResponse(response, 200, healthBody());
        return;
      }
      if (url.pathname === '/api/snapshot') {
        jsonResponse(response, 200, getSnapshot(url.searchParams.get('scope') === 'all' ? 'all' : 'relevant'));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write('retry: 3000\n');
      response.write('event: snapshot\n');
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'relevant';
      response.write('data: ' + JSON.stringify(getSnapshot(scope)) + '\n\n');
      const subscriber = { response, scope };
      subscribers.add(subscriber);
      request.on('close', () => subscribers.delete(subscriber));
      return;
    }
    jsonResponse(response, 404, { error: 'Not found.' });
  }

  const serverOptions = config.tls.enabled
    ? { key: fs.readFileSync(config.tls.keyFile), cert: fs.readFileSync(config.tls.certFile) }
    : {};
  server = config.tls.enabled ? https.createServer(serverOptions, requestHandler) : http.createServer(requestHandler);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    server.listen(config.port, config.bindHost, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const runtime = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        serverVersion: SERVER_VERSION,
        protocol: config.tls.enabled ? 'https' : 'http',
        bindHost: config.bindHost,
        port: address && address.port,
        tokenFile: config.auth.tokenFile,
        configPath
      };
      fs.writeFileSync(path.join(root, 'data', 'monitor.pid.json'), JSON.stringify(runtime, null, 2), 'utf8');
      fs.writeFileSync(path.join(root, 'data', 'monitor.runtime.json'), JSON.stringify(runtime, null, 2), 'utf8');
      pollTimer = setInterval(() => {
        try { emitSnapshot(false); } catch (error) { process.stderr.write('poll error: ' + error.message + '\n'); }
      }, config.pollMs);
      pollTimer.unref();
      heartbeatTimer = setInterval(() => {
        for (const subscriber of subscribers) {
          try { subscriber.response.write(': heartbeat\n\n'); } catch { subscribers.delete(subscriber); }
        }
      }, 15000);
      heartbeatTimer.unref();
      emitSnapshot(true);
      resolve({
        server,
        config,
        runtime,
        getSnapshot,
        healthBody,
        close: cleanup
      });
    });
  });

  function cleanup() {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const subscriber of subscribers) {
      try { subscriber.response.end(); } catch {}
    }
    subscribers.clear();
    adapter.close();
    if (server && server.listening) {
      server.close();
    }
    try {
      const pidPath = path.join(root, 'data', 'monitor.pid.json');
      const record = loadJsonFile(pidPath, {});
      if (integer(record.pid) === process.pid) fs.unlinkSync(pidPath);
    } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  let configPath = process.env.MONITOR_CONFIG || '';
  let syntheticFile = process.env.MONITOR_SYNTHETIC_FILE || '';
  let allowHttp = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--config') configPath = args[index + 1] || configPath;
    if (args[index] === '--synthetic-file') syntheticFile = args[index + 1] || syntheticFile;
    if (args[index] === '--http') allowHttp = true;
  }
  const root = path.resolve(__dirname, '..');
  const config = loadJsonFile(configPath || path.join(root, 'config', 'monitor.json'), {});
  if (allowHttp) config.tls = { ...(config.tls || {}), enabled: false };
  const running = await startServer({ root, configPath: configPath || path.join(root, 'config', 'monitor.json'), config, syntheticFile });
  process.stdout.write('Codex Multi-Session Monitor listening on ' + running.runtime.protocol + '://' + running.runtime.bindHost + ':' + running.runtime.port + '\n');
  process.stdout.write('PID ' + running.runtime.pid + '\n');
  process.on('SIGINT', () => { running.close(); process.exit(0); });
  process.on('SIGTERM', () => { running.close(); process.exit(0); });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('startup error: ' + error.stack + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  SERVER_VERSION,
  STATUS_RANK,
  classifySession,
  classifyLiveSession,
  parseLiveRollout,
  createRolloutTracker,
  redactExact,
  createLiveAdapter,
  itemPreview,
  progressFromItem,
  normalizeConfig,
  redact,
  stableDigest,
  startServer
};
