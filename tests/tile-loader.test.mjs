import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileLoader } from '../game/prototype/tileLoader.js';

test('写真の同時取得・デコードを制限し、一時失敗を再試行', async t => {
  let active = 0, max = 0;
  const calls = new Map();
  t.mock.method(globalThis, 'fetch', async url => {
    active++; max = Math.max(max, active);
    const n = (calls.get(url) || 0) + 1; calls.set(url, n);
    await new Promise(resolve => setTimeout(resolve, 3));
    if (url === 'retry' && n === 1) { active--; throw new Error('offline'); }
    return { ok: true, status: 200, blob: async () => url };
  });
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async value => {
    await new Promise(resolve => setTimeout(resolve, 3)); active--; return value;
  };
  try {
    const load = createTileLoader({ concurrency: 2 });
    assert.deepEqual(await Promise.all(['a', 'retry', 'c', 'd'].map(load)), ['a', 'retry', 'c', 'd']);
    assert.equal(max, 2); assert.equal(calls.get('retry'), 2);
  } finally { globalThis.createImageBitmap = previous; }
});

test('404は再試行せず、タイムアウトでも待ち行列を解放', async t => {
  const calls = new Map();
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (url === 'missing') return Promise.resolve({ ok: false, status: 404 });
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
  });
  const load = createTileLoader({ concurrency: 1, timeoutMs: 10 });
  const results = await Promise.allSettled(['slow', 'missing'].map(load));
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(calls.get('slow'), 2);
  assert.equal(calls.get('missing'), 1);
});
