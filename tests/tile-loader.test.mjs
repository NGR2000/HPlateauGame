import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileLoader } from '../game/prototype/tileLoader.js';

const tile = name => `https://cyberjapandata.gsi.go.jp/${name}.png`;
function png(width = 256, height = 256) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, width, height].forEach((v, i) => view.setUint32(i * 4, v));
  return bytes;
}

test('写真の同時取得・デコードを制限し、一時失敗を再試行', async t => {
  let active = 0, max = 0;
  const calls = new Map();
  t.mock.method(globalThis, 'fetch', async url => {
    active++; max = Math.max(max, active);
    const n = (calls.get(url) || 0) + 1; calls.set(url, n);
    await new Promise(resolve => setTimeout(resolve, 3));
    if (url === tile('retry') && n === 1) { active--; throw new Error('offline'); }
    return new Response(png(), { headers: { 'content-type': 'image/png' } });
  });
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async value => {
    assert.equal(value.type, 'image/png');
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    return { width: 256, height: 256 };
  };
  try {
    const load = createTileLoader({ concurrency: 2 });
    assert.equal((await Promise.all(['a', 'retry', 'c', 'd'].map(n => load(tile(n))))).length, 4);
    assert.equal(max, 2); assert.equal(calls.get(tile('retry')), 2);
  } finally { globalThis.createImageBitmap = previous; }
});

test('404は再試行せず、タイムアウトでも待ち行列を解放', async t => {
  const calls = new Map();
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (url === tile('missing')) return Promise.resolve(new Response('', { status: 404 }));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
  });
  const load = createTileLoader({ concurrency: 1, timeoutMs: 10 });
  const results = await Promise.allSettled(['slow', 'missing'].map(n => load(tile(n))));
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(calls.get(tile('slow')), 2);
  assert.equal(calls.get(tile('missing')), 1);
});

test('巨大な画像や画像以外の応答はデコード前に拒否する', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    return new Response(url === tile('large') ? png(20000, 20000) : '<script>bad</script>');
  });
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = () => { throw new Error('must not decode'); };
  try {
    const load = createTileLoader();
    await assert.rejects(load(tile('large')), /大きさ/);
    await assert.rejects(load(tile('html')), /形式/);
    assert.equal(calls, 2);
  } finally { globalThis.createImageBitmap = previous; }
});
