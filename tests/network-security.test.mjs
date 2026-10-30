import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRemoteUrl, fetchBytes, fetchJson } from '../game/prototype/safeFetch.js';
import { decodeRoadLayer } from '../game/prototype/road.js';
import { parseB3dmHeader, readRtcCenter } from '../game/prototype/plateau.js';

const url = 'https://api.open-meteo.com/v1/forecast';
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function glb(value) {
  let json = JSON.stringify(value);
  json += ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4);
  const text = new TextEncoder().encode(json);
  const out = new ArrayBuffer(20 + text.length);
  const view = new DataView(out);
  [0x46546c67, 2, out.byteLength, text.length, 0x4e4f534a].forEach((v, i) => view.setUint32(i * 4, v, true));
  new Uint8Array(out, 20).set(text);
  return out;
}

test('外部データのURLは許可したHTTPSホストだけを受け付ける', () => {
  assert.equal(assertRemoteUrl(url), url);
  for (const value of ['http://api.open-meteo.com/v1', 'https://api.open-meteo.com.evil.test/',
    'https://evil.test/', 'https://localhost/', 'file:///etc/passwd', 'data:text/plain,x',
    'https://user:password@api.open-meteo.com/', 'https://api.open-meteo.com:8443/']) {
    assert.throws(() => assertRemoteUrl(value), /取得先|URL/);
  }
});

test('外部取得は資格情報を送らず、リダイレクトを追跡しない', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return new Response('ok');
  });
  assert.equal(new TextDecoder().decode(await fetchBytes(url)), 'ok');
  await assert.rejects(fetchBytes('https://evil.test/'), /取得先/);
  assert.equal(calls, 1);
});

test('転送済みの応答は処理しない', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    const response = new Response('redirected');
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  await assert.rejects(fetchBytes(url), /転送/);
});

test('Content-Lengthが無くてもストリームの実受信量を制限する', async t => {
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); },
    cancel() { canceled = true; },
  })));
  await assert.rejects(fetchBytes(url, { maxBytes: 8 }), /データ量/);
  assert.equal(canceled, true);
});

test('過大なContent-Lengthは本文を読む前に拒否する', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('small', { headers: { 'content-length': '1000000' } }));
  await assert.rejects(fetchBytes(url, { maxBytes: 8 }), /データ量/);
});

test('ヘッダー後に停止する本文にもタイムアウトを適用する', async t => {
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await assert.rejects(fetchBytes(url, { timeoutMs: 10 }), /タイムアウト/);
  assert.equal(canceled, true);
});

test('HTTPエラー・JSONの型・構造・呼出元の検証を維持する', async t => {
  let response = new Response('missing', { status: 404 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(fetchBytes(url), error => error.status === 404 && error.retryable === false);
  response = new Response('{"ok":true}', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchJson(url), /JSONではない/);
  response = jsonResponse({ hourly: { time: ['2026-10-25T07:00'] } });
  assert.equal((await fetchJson(url, { validate: d => Array.isArray(d.hourly.time) })).hourly.time.length, 1);
  response = jsonResponse({ wrong: true });
  await assert.rejects(fetchJson(url, { validate: d => !!d.hourly }), /項目/);
  let nested = {};
  for (let i = 0; i < 40; i++) nested = { nested };
  response = jsonResponse(nested);
  await assert.rejects(fetchJson(url), /構造/);
});

test('切れたprotobufや過大な長さの道路タイルを拒否する', () => {
  const valid = new Uint8Array([0x1a, 9, 0x0a, 4, ...new TextEncoder().encode('road'), 0x28, 0x80, 0x20]);
  assert.equal(decodeRoadLayer(valid).extent, 4096);
  for (const bytes of [new Uint8Array([0x1a, 0x80]), new Uint8Array([0x1a, 127]),
    new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])]) {
    assert.throws(() => decodeRoadLayer(bytes), /道路/);
  }
});

test('b3dmの短いヘッダーと範囲外のGLBオフセットを拒否する', () => {
  assert.throws(() => parseB3dmHeader(new ArrayBuffer(4)), /短すぎ/);
  const header = new ArrayBuffer(28);
  const view = new DataView(header);
  new Uint8Array(header).set(new TextEncoder().encode('b3dm'));
  view.setUint32(4, 1, true); view.setUint32(8, 48, true);
  assert.equal(parseB3dmHeader(header).glbLength, 20);
  view.setUint32(12, 10000, true);
  assert.throws(() => parseB3dmHeader(header), /範囲/);
});

test('GLBの外部URI・過大な頂点数・不正な位置を展開前に拒否する', () => {
  const valid = { asset: { version: '2.0' }, extensions: { CESIUM_RTC: { center: [1, 2, 3] } } };
  assert.deepEqual(readRtcCenter(glb(valid)), [1, 2, 3]);
  assert.throws(() => readRtcCenter(glb({ ...valid, buffers: [{ uri: 'https://evil.test/model.bin' }] })), /外部リソース/);
  assert.throws(() => readRtcCenter(glb({ ...valid, accessors: [{ count: 1000000000 }] })), /要素数/);
  assert.throws(() => readRtcCenter(glb({ asset: valid.asset, extensions: { CESIUM_RTC: { center: ['1', 2, 3] } } })), /位置/);
  const broken = glb(valid); new DataView(broken).setUint32(8, broken.byteLength + 4, true);
  assert.throws(() => readRtcCenter(broken), /ヘッダー/);
});
