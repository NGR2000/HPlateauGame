import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFiles = ['index.html', 'game/prototype/index.html', 'game/prototype/play.html', 'game/prototype/city-editor.html'];
const assets = ['MV56b_hot_air_balloon.glb', 'sky_chase_car.glb', 'exterior.glb', 'sports_center.glb', 'tokyo_station.glb', 'tokyo_tower.glb'];
const forbiddenModules = new Set(['road.js', 'plateau.js', 'chasecar.js']);
const threeVersion = '0.160.0';
const vendorPrefix = 'game/prototype/vendor/three/';

// Match static import/export statements, including multiline named imports. Dynamic
// imports are deliberately unsupported in the public graph: add explicit reviewed
// entry points if they become necessary rather than publishing a whole directory.
function imports(source) {
  const found = [];
  const expression = /(?:^|[;\n])\s*(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+)["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) found.push(match[1]);
  if (/\bimport\s*\(/.test(source)) throw new Error('Dynamic imports require an explicit public build rule');
  return found;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function safeSource(base, relative) {
  const filename = path.resolve(base, relative);
  if (!inside(base, filename)) throw new Error(`Source is outside its root: ${relative}`);
  const resolved = await realpath(filename);
  if (resolved !== filename || !(await lstat(filename)).isFile()) throw new Error(`Only regular, non-symlink sources are published: ${relative}`);
  return filename;
}

function localReference(from, value) {
  if (!value.startsWith('./') && !value.startsWith('../')) throw new Error(`External or absolute public resource: ${value}`);
  if (/[?#\\]/.test(value)) throw new Error(`Unsupported resource reference: ${value}`);
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
}

export function secureHtml(source) {
  // Only this exact pinned legacy mapping is rewritten; unexpected remote code
  // references fail validation below rather than silently obtaining trust.
  let html = source.replaceAll(`https://cdn.jsdelivr.net/npm/three@${threeVersion}/`, './vendor/three/');
  if (/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(html)) throw new Error('CSP is owned by the build; remove conflicting source policies');
  if (/\son[a-z]+\s*=/i.test(html)) throw new Error('Inline event handlers are not permitted');
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1];
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) {
      if (!src.startsWith('./') || /[?#\\]/.test(src)) throw new Error(`External script is not permitted: ${src}`);
    } else {
      if (/\btype\s*=\s*["']importmap["']/i.test(attrs)) {
        const map = JSON.parse(match[2]);
        if (map.scopes || !map.imports || Object.keys(map).some(key => key !== 'imports')) throw new Error('Unsupported import map');
        for (const [name, target] of Object.entries(map.imports)) {
          const expected = name === 'three' ? './vendor/three/build/three.module.js'
            : name === 'three/addons/' ? './vendor/three/examples/jsm/' : null;
          if (target !== expected) throw new Error(`Unapproved import mapping: ${name}`);
        }
      }
      hashes.push(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
    }
  }
  const policy = [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "script-src-attr 'none'",
    // Existing UI uses inline style attributes; this does not permit inline scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https://cyberjapandata.gsi.go.jp",
    // GLB textures are extracted into local blob URLs by Three.js.
    "connect-src 'self' blob: https://cyberjapandata.gsi.go.jp",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join('; ');
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('Public HTML must contain a head element');
  html = html.replace(/<head\b[^>]*>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="${policy}">\n<meta name="referrer" content="no-referrer">`);
  return html;
}

async function vendorFiles(repoRoot, includeDevelopment) {
  const base = path.join(repoRoot, 'node_modules/three');
  const metadata = JSON.parse(await readFile(await safeSource(base, 'package.json'), 'utf8'));
  if (metadata.version !== threeVersion) throw new Error(`Expected three@${threeVersion}; run npm ci`);
  const files = new Map();
  async function visit(relative) {
    if (files.has(relative)) return;
    const filename = await safeSource(base, relative);
    files.set(relative, filename);
    const text = await readFile(filename, 'utf8');
    for (const specifier of imports(text)) {
      const target = specifier === 'three' ? 'build/three.module.js'
        : specifier.startsWith('three/addons/') ? `examples/jsm/${specifier.slice(13)}`
          : localReference(relative, specifier);
      await visit(target);
    }
  }
  await visit('build/three.module.js');
  await visit('examples/jsm/controls/OrbitControls.js');
  await visit('examples/jsm/loaders/GLTFLoader.js');
  if (includeDevelopment) {
    await visit('examples/jsm/loaders/DRACOLoader.js');
    for (const relative of ['examples/jsm/libs/draco/draco_decoder.js', 'examples/jsm/libs/draco/draco_decoder.wasm', 'examples/jsm/libs/draco/draco_wasm_wrapper.js']) {
      files.set(relative, await safeSource(base, relative));
    }
  }
  files.set('LICENSE', await safeSource(base, 'LICENSE'));
  return files;
}

export async function prepareVendor(repoRoot = root) {
  const target = path.join(repoRoot, vendorPrefix);
  await mkdir(target, { recursive: true });
  for (const [relative, filename] of await vendorFiles(repoRoot, true)) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(filename, destination);
  }
}

export async function buildSite({ repoRoot = root, outputDir = path.join(repoRoot, 'dist') } = {}) {
  repoRoot = await realpath(repoRoot);
  outputDir = path.resolve(outputDir);
  if (outputDir === repoRoot || inside(outputDir, repoRoot) || inside(path.join(repoRoot, 'game'), outputDir)) {
    throw new Error('Output must not overwrite the repository or game sources');
  }
  const files = new Map();
  async function visitModule(relative) {
    if (!relative.startsWith('game/prototype/') || forbiddenModules.has(path.posix.basename(relative)) || relative.includes('/vendor/')) {
      throw new Error(`Non-public module reached from public entry: ${relative}`);
    }
    if (files.has(relative)) return;
    const text = await readFile(await safeSource(repoRoot, relative), 'utf8');
    files.set(relative, text);
    for (const specifier of imports(text)) {
      if (specifier === 'three' || specifier === 'three/addons/controls/OrbitControls.js' || specifier === 'three/addons/loaders/GLTFLoader.js') continue;
      await visitModule(localReference(relative, specifier));
    }
  }
  for (const relative of htmlFiles) {
    const source = await readFile(await safeSource(repoRoot, relative), 'utf8');
    const html = secureHtml(source);
    files.set(relative, html);
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      await visitModule(localReference(relative, match[1]));
    }
    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
      if (!/\brel\s*=\s*["']stylesheet["']/i.test(match[0])) continue;
      const href = match[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      const target = localReference(relative, href ?? '');
      if (!target.startsWith('game/prototype/') || !target.endsWith('.css')) throw new Error(`Non-public stylesheet: ${target}`);
      files.set(target, await readFile(await safeSource(repoRoot, target), 'utf8'));
    }
  }
  // Verify the complete source graph before replacing the previous build.
  const publicVendor = await vendorFiles(repoRoot, false);
  const models = new Map();
  for (const name of assets) {
    const relative = `game/prototype/assets/${name}`;
    models.set(relative, await safeSource(repoRoot, relative));
  }
  await rm(outputDir, { recursive: true, force: true });
  for (const [relative, content] of files) {
    const target = path.join(outputDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const [relative, filename] of [...models, ...[...publicVendor].map(([name, filename]) => [vendorPrefix + name, filename])]) {
    const target = path.join(outputDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(filename, target);
    files.set(relative, null);
  }
  await writeFile(path.join(outputDir, '.nojekyll'), '');
  return { outputDir, files: [...files.keys()].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareVendor();
  if (!process.argv.includes('--vendor-only')) {
    const result = await buildSite();
    console.log(`Built ${result.files.length} public files in ${result.outputDir}; development files excluded.`);
  }
}
