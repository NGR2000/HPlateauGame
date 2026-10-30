import test from 'node:test';
import assert from 'node:assert/strict';
import { groundReportStatus, chasePoints } from '../game/prototype/chaseRules.js';
import { createBalloonAutopilot } from '../game/prototype/balloonAutopilot.js';

test('地上風報告: 距離・停止速度の境界と競技状態', () => {
  const status = (distance, speedMps = 0, extra = {}) => groundReportStatus({ active: true, distance, speedMps, ...extra });
  assert.equal(status(99.99), 'too-close');
  assert.equal(status(100, 0.05), 'too-close');
  assert.equal(status(100.01, 0.05), 'ready');
  assert.equal(status(400, -0.05), 'ready');
  assert.equal(status(400.01), 'too-far');
  assert.equal(status(200, 0.051), 'moving');
  assert.equal(status(200, -0.051), 'moving');
  assert.equal(status(NaN), 'too-close');
  assert.equal(status(200, NaN), 'moving');
  assert.equal(status(200, 0, { active: false }), 'inactive');
  assert.equal(status(200, 0, { reported: true }), 'reported');
});

test('回収1,000点・着地後500点・報告50点・未回収0点', () => {
  assert.deepEqual(chasePoints({ caught: true, reported: true }), { recovery: 1000, report: 50, total: 1050 });
  assert.equal(chasePoints({ caught: true, afterLanding: true, reported: true }).total, 550);
  assert.equal(chasePoints({ caught: true, afterLanding: true }).total, 500);
  assert.equal(chasePoints({ reported: true }).total, 50);
  assert.equal(chasePoints({}).total, 0);
});

test('予告は60秒以内に一度、投下拒否後も成功までは再要求', () => {
  const pilot = createBalloonAutopilot({ targetX: 0, targetZ: 0, windAt: () => ({ vx: -10, vz: 0, kt: 20 }) });
  const p = x => ({ x, y: 100, z: 0 });
  assert.equal(pilot.dropNotice(p(1001)), null);
  assert.equal(pilot.dropNotice(p(1000)), 60);
  assert.equal(pilot.dropNotice(p(500)), null);
  assert.equal(pilot.shouldDrop(p(400)), true);
  assert.equal(pilot.shouldDrop(p(400)), true);
  pilot.markDropped();
  assert.equal(pilot.shouldDrop(p(400)), false);
});

test('離れる風・無風では誤った投下予告をしない', () => {
  for (const vx of [0, 10]) {
    const pilot = createBalloonAutopilot({ targetX: 0, targetZ: 0, windAt: () => ({ vx, vz: 0, kt: 20 }) });
    assert.equal(pilot.dropNotice({ x: 500, y: 100, z: 0 }), null);
  }
});
