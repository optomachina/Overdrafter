'use strict';
// Future container-only inspector. Built-ins only; never imports worker/browser code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SHA = '7da20710b25a6a30d0f9ac59e88e00f685defc67';

function ensure(value, code) { if (!value) throw new Error(code); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
// Published package metadata may prefix a canonical npm version with one lowercase v.
// Compare the complete canonical strings; preserve the raw installed value in evidence.
function packageVersionMatches(observed, locked) {
  if (typeof observed !== 'string' || typeof locked !== 'string') return false;
  const canonical = observed.startsWith('v') ? observed.slice(1) : observed;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*))*))?(?:\+([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/;
  const match = semver.exec(canonical);
  return match !== null && match[0] === canonical && canonical === locked;
}
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function inventory(dir, prefix = 'dist') {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    ensure(!entry.isSymbolicLink(), 'dist_symlink_rejected');
    if (entry.isDirectory()) result.push(...inventory(path.join(dir, entry.name), relative));
    else { ensure(entry.isFile(), 'dist_nonregular_rejected'); result.push(relative); }
  }
  return result.sort();
}
function executable(file) {
  ensure(fs.statSync(file).isFile(), 'executable_not_regular');
  fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
  return file;
}
function assertNoMmdb(roots) {
  for (const root of roots) {
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        ensure(!entry.name.toLowerCase().endsWith('.mmdb'), 'mmdb_present');
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
      }
    }
  }
}
function validateManifest(manifest) {
  ensure(Array.isArray(manifest) && manifest.length === 107, 'manifest_count_mismatch');
  const seen = new Set();
  for (const item of manifest) {
    ensure(item && typeof item.path === 'string' &&
      /^(?:package(?:-lock)?\.json|dist\/[a-zA-Z0-9_./-]+)$/.test(item.path) &&
      !item.path.split('/').some(part => !part || part === '.' || part === '..'), 'manifest_path_invalid');
    ensure(!seen.has(item.path), 'manifest_duplicate'); seen.add(item.path);
    ensure(/^[0-9a-f]{64}$/.test(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes >= 0,
      'manifest_metadata_invalid');
  }
  ensure(seen.has('package.json') && seen.has('package-lock.json') && seen.has('dist/index.js'),
    'manifest_required_file_missing');
  return manifest;
}
async function main() {
  ensure(process.platform === 'linux' && process.arch === 'x64', 'runtime_platform_mismatch');
  ensure(process.env.WORKER_BUILD_VERSION === SHA, 'runtime_build_version_mismatch');
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  ensure(/^ID=ubuntu$/m.test(osRelease) && /^VERSION_ID="24\.04"$/m.test(osRelease), 'runtime_os_release_mismatch');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8'); ensure(input.length <= 128 * 1024, 'manifest_too_large');
  }
  const manifest = validateManifest(JSON.parse(input));
  const expectedDist = manifest.filter(item => item.path.startsWith('dist/')).map(item => item.path).sort();
  ensure(JSON.stringify(inventory('/app/dist')) === JSON.stringify(expectedDist), 'dist_inventory_mismatch');
  for (const item of manifest) {
    const file = path.join('/app', item.path);
    const stat = fs.lstatSync(file);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size === item.bytes, 'critical_file_metadata_mismatch');
    ensure(await hash(file) === item.sha256, 'critical_file_hash_mismatch');
  }
  const lock = json('/app/package-lock.json');
  const packages = {};
  for (const name of ['playwright', 'playwright-core', 'patchright', 'patchright-core', 'camoufox-js']) {
    const installed = json(`/app/node_modules/${name}/package.json`);
    const locked = lock.packages?.[`node_modules/${name}`];
    ensure(locked && installed.name === name && packageVersionMatches(installed.version, locked.version),
      'package_version_mismatch');
    packages[name] = installed.version;
  }
  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  ensure(browserRoot === '/ms-playwright', 'browser_cache_path_mismatch');
  const browserEvidence = [];
  for (const core of ['playwright-core', 'patchright-core']) {
    const catalog = json(`/app/node_modules/${core}/browsers.json`);
    for (const name of ['chromium', 'chromium-headless-shell']) {
      const row = catalog.browsers?.find(browser => browser.name === name);
      ensure(row && /^\d+$/.test(row.revision) && row.installByDefault === true, 'browser_catalog_invalid');
      // This candidate is Ubuntu 24.04 x64. Honor an explicit platform revision override.
      const revision = row.revisionOverrides?.['ubuntu24.04-x64'] ?? row.revision;
      ensure(/^\d+$/.test(revision), 'browser_revision_invalid');
      const dirname = row.revisionOverrides?.['ubuntu24.04-x64']
        ? `${name}_ubuntu24.04-x64_special` : name;
      const executableRelative = name === 'chromium'
        ? 'chrome-linux64/chrome' : 'chrome-headless-shell-linux64/chrome-headless-shell';
      const file = path.join(browserRoot, `${dirname.replaceAll('-', '_')}-${revision}`, executableRelative);
      executable(file);
      browserEvidence.push({ package: core, name, revision, executable: file, sha256: await hash(file) });
    }
  }
  const camoufoxRoot = '/root/.cache/camoufox';
  const camoufoxVersion = json(`${camoufoxRoot}/version.json`);
  ensure(camoufoxVersion.version === '152.0.4' && camoufoxVersion.release === 'beta.28', 'camoufox_version_mismatch');
  const camoufoxBinary = executable(`${camoufoxRoot}/camoufox-bin`);
  assertNoMmdb(['/app', '/root/.cache', '/ms-playwright']);
  const ubo = json(`${camoufoxRoot}/addons/UBO/manifest.json`);
  ensure(ubo.version === '1.73.0', 'ubo_version_mismatch');
  const utilities = ['Xvfb', 'pdfinfo', 'pdftoppm'].map(name => executable(`/usr/bin/${name}`));
  process.stdout.write(`${JSON.stringify({
    schema: 'ovd419.offline-image-inspection.v1', status: 'passed',
    sourceSha: SHA, runtime: { platform: process.platform, arch: process.arch, node: process.version },
    criticalFileCount: manifest.length, distFileCount: expectedDist.length,
    criticalManifestSha256: crypto.createHash('sha256').update(input).digest('hex'),
    packages, browsers: browserEvidence,
    camoufox: { version: '152.0.4', release: 'beta.28', binarySha256: await hash(camoufoxBinary) },
    geoipDatabaseAbsent: true, uboVersion: '1.73.0', utilities,
    scope: 'filesystem metadata and hashes only; worker and browsers not launched',
  })}\n`);
}
module.exports = { validateManifest, packageVersionMatches, assertNoMmdb };
if (require.main === module || process.argv[1] === undefined) {
  main().catch(error => {
    // Only our fixed failure tokens are emitted, never raw filesystem/package data.
    const code = /^[a-z_]+$/.test(error.message) ? error.message : 'inspection_read_or_parse_failed';
    process.stdout.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  });
}
