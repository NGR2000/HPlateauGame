import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSite, secureHtml } from '../tools/build-site.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hplateau-public-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(relative, body = '') {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  for (const name of ['index.html', 'game/prototype/index.html', 'game/prototype/play.html', 'game/prototype/city-editor.html']) {
    await put(name, '<!doctype html><html><head></head><body>Game</body></html>');
  }
  await put('game/prototype/play.html', '<html><head><script type="module" src="./main.js"></script></head><body>Game</body></html>');
  await put('game/prototype/main.js', "import * as THREE from 'three';\nimport { setting } from './settings.js';");
  await put('game/prototype/settings.js', 'export const setting = 1;');
  await put('game/development/play.html', '<h1>Private development entry</h1>');
  await put('game/prototype/secret.txt', 'This is not a runtime dependency.');
  await put('game/prototype/unused.js', 'throw new Error("do not publish");');
  await put('game/experiments/index.html', '<h1>Experiment</h1>');
  for (const name of ['MV56b_hot_air_balloon.glb', 'sky_chase_car.glb', 'exterior.glb', 'sports_center.glb', 'tokyo_station.glb', 'tokyo_tower.glb']) {
    await put(`game/prototype/assets/${name}`, 'fixture');
  }
  await put('game/prototype/assets/source/private.blend', 'do not publish');
  await put('node_modules/three/package.json', JSON.stringify({ version: '0.160.0' }));
  for (const name of ['build/three.module.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/loaders/GLTFLoader.js', 'LICENSE']) {
    await put(`node_modules/three/${name}`, '// test fixture\n');
  }
  return { root, put };
}

test('published site includes only reachable runtime modules and named browser assets', async t => {
  const { root } = await fixture(t);
  const result = await buildSite({ repoRoot: root });
  assert.ok(result.files.includes('game/prototype/main.js'));
  assert.ok(result.files.includes('game/prototype/settings.js'));
  assert.ok(result.files.includes('game/prototype/vendor/three/build/three.module.js'));
  assert.ok(result.files.includes('game/prototype/assets/sky_chase_car.glb'));
  const all = await readdir(result.outputDir, { recursive: true });
  for (const name of all) {
    assert.doesNotMatch(name, /development|experiments|secret|unused|\.blend|node_modules/);
  }
  assert.match(await readFile(path.join(result.outputDir, 'game/prototype/play.html'), 'utf8'), /Content-Security-Policy/);
});

test('build rejects a reachable development module, even if its entry link is hidden', async t => {
  const { root, put } = await fixture(t);
  await put('game/prototype/main.js', "import './road.js';");
  await put('game/prototype/road.js', 'export const hidden = true;');
  await assert.rejects(buildSite({ repoRoot: root }), /Non-public module/);
  await put('game/prototype/main.js', "import '../development/private.js';");
  await put('game/development/private.js', 'export const hidden = true;');
  await assert.rejects(buildSite({ repoRoot: root }), /Non-public module/);
});

test('public graph rejects remote code, dynamic imports and symlink escapes', async t => {
  const { root, put } = await fixture(t);
  await put('game/prototype/main.js', "import 'https://untrusted.example/module.js';");
  await assert.rejects(buildSite({ repoRoot: root }), /External or absolute/);
  await put('game/prototype/main.js', "import('./settings.js');");
  await assert.rejects(buildSite({ repoRoot: root }), /Dynamic imports/);
  await put('game/prototype/main.js', "import './linked.js';");
  await put('game/development/private.js', 'export const privateData = true;');
  await symlink('../development/private.js', path.join(root, 'game/prototype/linked.js'));
  await assert.rejects(buildSite({ repoRoot: root }), /non-symlink/);
});

test('CSP trusts exact inline contents and local pinned dependencies, without remote script permissions', () => {
  const script = 'location.replace("./game/prototype/");';
  const map = JSON.stringify({ imports: { three: './vendor/three/build/three.module.js', 'three/addons/': './vendor/three/examples/jsm/' } });
  const html = secureHtml(`<html><head><script>${script}</script><script type="importmap">${map}</script></head><body></body></html>`);
  const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const scripts = policy.split('; ').find(item => item.startsWith('script-src '));
  assert.ok(scripts.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.ok(scripts.includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`));
  assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval|https:|blob:|\*/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /connect-src 'self' blob: https:\/\/cyberjapandata\.gsi\.go\.jp(?:;|$)/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /worker-src 'none'/);
  assert.doesNotMatch(policy, /frame-ancestors/); // Not supported by meta CSP.
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('build refuses unexpected import maps and inline event handlers', () => {
  assert.throws(() => secureHtml('<html><head><script src="https://untrusted.example/x.js"></script></head></html>'), /External script/);
  assert.throws(() => secureHtml('<html><head></head><body onload="alert(1)"></body></html>'), /Inline event/);
  assert.throws(() => secureHtml('<html><head><script type="importmap">{"imports":{"three":"https://untrusted.example/three.js"}}</script></head></html>'), /Unapproved import/);
});
