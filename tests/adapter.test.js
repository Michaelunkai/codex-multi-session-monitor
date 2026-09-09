'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySession,
  itemPreview,
  progressFromItem,
  redact
} = require('../app/server.js');

const config = {
  activeWindowSeconds: 600,
  staleWindowSeconds: 1800,
  attentionWindowSeconds: 900,
  relevantHours: 24
};

function meta(updatedAtMs) {
  return { updatedAtMs, id: 'test-session', cwd: 'F:\\test\\project' };
}

function turn(status, startedAtMs, completedAtMs = 0) {
  return { id: 'turn-1', status, startedAtMs, completedAtMs };
}

test('classifies fresh and stale persisted turn states without overstating old inProgress rows', () => {
  const now = Date.now();
  assert.equal(classifySession(meta(now - 2_000), turn('inProgress', now - 2_000), {}, now, config).status, 'RUNNING');
  assert.equal(classifySession(meta(now - 1_200_000), turn('inProgress', now - 1_200_000), {}, now, config).status, 'STUCK');
  assert.equal(classifySession(meta(now - 7_200_000), turn('inProgress', now - 7_200_000), {}, now, config).status, 'INACTIVE');
});

test('labels terminal and attention states with their reliability boundary', () => {
  const now = Date.now();
  const recentCompleted = classifySession(meta(now - 5_000), turn('completed', now - 20_000, now - 5_000), {}, now, config);
  const olderCompleted = classifySession(meta(now - 7_200_000), turn('completed', now - 7_210_000, now - 7_200_000), {}, now, config);
  const failed = classifySession(meta(now - 5_000), turn('failed', now - 10_000), {}, now, config);
  assert.equal(recentCompleted.status, 'WAITING');
  assert.match(recentCompleted.reliability, /heuristic/);
  assert.equal(olderCompleted.status, 'COMPLETED');
  assert.equal(olderCompleted.reliability, 'direct persisted turn status');
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.reliability, 'direct persisted turn status');
});

test('previews and plan progress are bounded and redact credential-shaped text', () => {
  assert.match(itemPreview('commandExecution', JSON.stringify({type:'commandExecution',command:'test-command',aggregatedOutput:'12 tests passed'})).preview, /12 tests passed/);
  assert.match(itemPreview('mcpToolCall', JSON.stringify({type:'mcpToolCall',server:'docs',tool:'search',status:'inProgress'})).preview, /docs.*search.*inProgress/);
  const raw = JSON.stringify({
    type: 'assistant',
    text: 'api_key=super-secret-value sk-abcdefghijklmnopqrstu'
  });
  const preview = itemPreview('assistant', raw);
  assert.match(preview.preview, /api_key=\[redacted\]/);
  assert.doesNotMatch(preview.preview, /super-secret-value|sk-abcdefghijklmnopqrstu/);
  assert.equal(redact('refresh_token: value123'), 'refresh_token=[redacted]');
  assert.deepEqual(
    progressFromItem({ parsed: { plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }] } }),
    { completed: 1, total: 2, current: 'two' }
  );
});
