'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseLiveRollout,
  parseLogActivity,
  classifyLiveSession,
  createRolloutTracker,
  applyIpcPatches,
  extractIpcTelemetry
} = require('../app/server.js');

function rollout(records) {
  return records.map((payload, index) => JSON.stringify({
    ordinal: index + 1,
    type: payload.type,
    timestamp: new Date(1_800_000_000_000 + index * 1000).toISOString(),
    payload: payload.payload
  })).join('\n') + '\n';
}

test('parses the currently active rollout and preserves complete user-visible output', () => {
  const longText = 'word '.repeat(500).trim();
  const text = rollout([
    { type: 'event_msg', payload: { type: 'task_started', thread_id: 'thread-1', turn_id: 'turn-1', started_at: 1_800_000_000 } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1', completed_at_ms: 1_800_000_001_000, item: { type: 'AgentMessage', id: 'msg-1', phase: 'commentary', content: [{ type: 'output_text', text: longText }] } } },
    { type: 'response_item', payload: { type: 'message', id: 'response-1', role: 'assistant', content: [{ type: 'output_text', text: longText }] } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1', completed_at_ms: 1_800_000_002_000, item: { type: 'CommandExecution', id: 'exec-1', command: ['pwsh', '-c', 'Write-Output'], stdout: 'line 1\nline 2', stderr: '', aggregated_output: 'line 1\nline 2', formatted_output: 'line 1\nline 2', status: 'completed' } } }
  ]);

  const parsed = parseLiveRollout(text, { now: 1_800_000_003_000 });
  assert.equal(parsed.active, true);
  assert.equal(parsed.turnId, 'turn-1');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].text, longText);
  assert.equal(parsed.entries[1].text, 'line 1\nline 2');
  assert.equal(parsed.entries[0].text.length, longText.length);
});

test('exposes current activity and assembles supported message deltas without waiting for completion', () => {
  const text = rollout([
    { type: 'event_msg', payload: { type: 'task_started', thread_id: 'thread-1', turn_id: 'turn-1', started_at: 1_800_000_000 } },
    { type: 'response_item', payload: { type: 'agent_message_delta', thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'msg-live', delta: 'word-by-' } },
    { type: 'response_item', payload: { type: 'agent_message_delta', thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'msg-live', delta: 'word stream' } },
    { type: 'event_msg', payload: { type: 'item_started', thread_id: 'thread-1', turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'exec-1', command: 'Get-Process' } } }
  ]);

  const parsed = parseLiveRollout(text, { now: 1_800_000_004_000 });
  assert.equal(parsed.active, true);
  assert.equal(parsed.latestActivity.kind, 'command-started');
  assert.equal(parsed.latestActivity.label, 'Running command');
  assert.equal(parsed.latestActivity.detail, 'Get-Process');
  const partial = parsed.entries.find((entry) => entry.id === 'msg-live');
  assert.ok(partial);
  assert.equal(partial.type, 'assistant-delta');
  assert.equal(partial.text, 'word-by-word stream');
});

test('maps the optional read-only Codex log projection to a safe per-thread activity label', () => {
  const activity = parseLogActivity({
    id: 42,
    ts: 1_800_000_004,
    thread_id: 'thread-1',
    target: 'codex_core::stream_events_utils',
    feedback_log_body: 'session_loop{thread_id=thread-1}:receiving_stream:handle_responses{otel.name="reasoning"}'
  });
  assert.equal(activity.kind, 'thinking');
  assert.equal(activity.label, 'Codex is thinking');
  assert.equal(activity.source, 'codex-logs');
  assert.equal(activity.timestampMs, 1_800_000_004_000);
});

test('only a fresh unfinished rollout is eligible for the running-only dashboard', () => {
  const now = 1_800_000_010_000;
  const config = { liveWindowSeconds: 20 };
  assert.equal(classifyLiveSession({
    active: true,
    lastActivityMs: now - 2_000,
    turnId: 'turn-1'
  }, now, config).status, 'RUNNING');
  assert.equal(classifyLiveSession({
    active: false,
    lastActivityMs: now - 2_000,
    turnId: 'turn-1'
  }, now, config).status, 'INACTIVE');
  assert.equal(classifyLiveSession({
    active: true,
    lastActivityMs: now - 21_000,
    turnId: 'turn-1'
  }, now, config).status, 'INACTIVE');
});

test('incremental rollout tracking exposes appended output and removes the card on completion', () => {
  const directory = path.join(__dirname, '..', 'temp', 'live-telemetry-test');
  const rolloutPath = path.join(directory, 'incremental.jsonl');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const line = (ordinal, payload, type = 'event_msg') => JSON.stringify({
    ordinal,
    type,
    timestamp: new Date(1_800_000_000_000 + ordinal * 1000).toISOString(),
    payload
  }) + '\n';
  try {
    fs.writeFileSync(rolloutPath, line(1, {
      type: 'task_started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      started_at: 1_800_000_000
    }) + line(2, {
      type: 'item_completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item: { type: 'AgentMessage', id: 'msg-1', content: [{ type: 'output_text', text: 'first durable block' }] }
    }));
    const tracker = createRolloutTracker();
    const first = tracker(rolloutPath, 1_800_000_003_000);
    assert.equal(first.active, true);
    assert.deepEqual(first.entries.map((entry) => entry.text), ['first durable block']);

    fs.appendFileSync(rolloutPath, line(3, {
      type: 'item_completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item: { type: 'AgentMessage', id: 'msg-2', content: [{ type: 'output_text', text: 'second durable block\nwith spacing' }] }
    }));
    const second = tracker(rolloutPath, 1_800_000_004_000);
    assert.equal(second.active, true);
    assert.deepEqual(second.entries.map((entry) => entry.text), ['first durable block', 'second durable block\nwith spacing']);

    fs.appendFileSync(rolloutPath, line(4, {
      type: 'task_complete',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      completed_at: 1_800_000_005
    }));
    const completed = tracker(rolloutPath, 1_800_000_006_000);
    assert.equal(completed.active, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replays Codex IPC patches and exposes the exact in-progress response text', () => {
  const state = {
    id: 'thread-1',
    title: 'Live session',
    cwd: 'F:\\project',
    threadRuntimeStatus: { type: 'active' },
    turnHistory: {
      history: {
        entitiesByKey: {
          'tail:0:local:tail-1': {
            turnId: 'turn-1',
            turnStartedAtMs: 1_800_000_000_000,
            status: 'inProgress',
            items: [{ type: 'agentMessage', id: 'msg-1', text: 'Hello' }]
          }
        }
      }
    }
  };
  applyIpcPatches(state, [{
    op: 'replace',
    path: ['turnHistory', 'history', 'entitiesByKey', 'tail:0:local:tail-1', 'items', 0, 'text'],
    value: 'Hello word-by-word in real time.'
  }]);
  const telemetry = extractIpcTelemetry(state, { receivedAtMs: 1_800_000_003_000, revision: 8 });
  assert.equal(telemetry.active, true);
  assert.equal(telemetry.turnId, 'turn-1');
  assert.equal(telemetry.source, 'codex-ipc');
  assert.equal(telemetry.entries[0].text, 'Hello word-by-word in real time.');
  assert.equal(telemetry.latestActivity.kind, 'ipc-live');
  assert.equal(telemetry.latestActivity.source, 'codex-ipc');
});
