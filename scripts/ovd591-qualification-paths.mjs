/** Standalone qualifier filesystem admission. No provisioning, chmod or fallback root.
 * RUNNER_TEMP is an existing operator-selected runner boundary, not a CLI path.
 * Same-UID processes remain inside the fixture owner's trust boundary. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path.startsWith(root + sep);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 });
const sameIdentity = (a, b) => assert.deepEqual(identity(a), identity(b), 'admitted filesystem identity changed');

function canonical(path) {
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
    'canonical absolute path required');
  assert.equal(realpathSync(path), path, 'symlinked path rejected');
  return path;
}
function owned(stat, uid, privateMode = false) {
  assert.equal(stat.uid, uid, 'runner-owned path required');
  assert.equal(stat.mode & (privateMode ? 0o077 : 0o022), 0, 'unsafe path permissions');
}
function trustedAncestors(path, uid) {
  // A private leaf is insufficient if another user can rename one of its parents.
  // Root/current-UID ownership is trusted; shared writable parents need sticky semantics.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'real ancestor directory required');
    assert(stat.uid === 0 || stat.uid === uid, 'untrusted ancestor owner');
    assert((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0, 'writable non-sticky ancestor');
    if (dirname(parent) === parent) break;
  }
}
function directory(path, uid, privateMode = false) {
  canonical(path); trustedAncestors(path, uid);
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'real directory required');
  owned(stat, uid, privateMode);
  return stat;
}
function directories(root, path, uid) {
  assert(path === root || inside(root, path), 'path outside admitted root');
  directory(root, uid);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part); directory(current, uid);
  }
}
function regular(stat, uid) {
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'single-link regular file required');
  owned(stat, uid);
}
/** O_NOFOLLOW + descriptor identity prevents leaf replacement between lstat/open.
 * Parent directories are canonical, owned and not writable by other users. */
function readOwned(root, path, uid, limit) {
  assert(inside(root, path), 'file outside admitted root');
  directories(root, dirname(path), uid); canonical(path);
  const before = lstatSync(path); regular(before, uid);
  assert(before.size > 0 && before.size <= limit, 'empty or oversized input');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); regular(opened, uid); sameIdentity(before, opened);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd); sameIdentity(opened, after);
    assert.equal(after.size, opened.size, 'input changed while reading');
    assert.equal(after.mtimeMs, opened.mtimeMs, 'input changed while reading');
    assert.equal(after.ctimeMs, opened.ctimeMs, 'input changed while reading');
    assert.equal(bytes.length, opened.size, 'incomplete input read');
    return { bytes, stat: opened };
  } finally { closeSync(fd); }
}

/** Admit every caller-controlled path before git/Docker access or output creation. */
export function admitQualificationPaths({ root, destination, provisioningPath, runnerTemp = process.env.RUNNER_TEMP }) {
  assert.equal(typeof process.getuid, 'function', 'POSIX filesystem ownership required');
  const uid = process.getuid();
  root = resolve(root); const rootStat = directory(root, uid);
  const runnerStat = directory(runnerTemp, uid);
  assert(runnerTemp !== root && !inside(root, runnerTemp) && !inside(runnerTemp, root),
    'runner evidence and source checkout must be separate');
  assert(typeof provisioningPath === 'string' && isAbsolute(provisioningPath)
    && resolve(provisioningPath) === provisioningPath, 'canonical provisioning path required');
  const fixture = dirname(provisioningPath);
  assert(inside(runnerTemp, fixture), 'private fixture directory under runner temp required');
  directories(runnerTemp, fixture, uid);
  const fixtureStat = directory(fixture, uid, true);
  assert(typeof destination === 'string' && isAbsolute(destination) && resolve(destination) === destination,
    'canonical output path required');
  assert.equal(dirname(destination), fixture, 'output must be a new child of the receipt directory');
  // lstat also detects dangling symlinks. Never adopt or truncate an existing target.
  try { lstatSync(destination); assert.fail('output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const receipt = readOwned(fixture, provisioningPath, uid, 1_000_000);
  const provisioning = JSON.parse(receipt.bytes);
  const evidence = {};
  for (const kind of ['migration', 'catalog']) {
    const entry = provisioning.evidence?.[kind];
    assert(entry && typeof entry.path === 'string' && entry.path.length > 0
      && /^[a-f0-9]{64}$/.test(entry.sha256), `${kind} raw evidence required`);
    // Absolute paths from the CI provisioner remain valid only within this receipt's directory.
    const path = isAbsolute(entry.path) ? entry.path : resolve(fixture, entry.path);
    if (!isAbsolute(entry.path)) assert.equal(relative(fixture, path), entry.path, 'noncanonical evidence path');
    const input = readOwned(fixture, path, uid, 8_000_000);
    assert.equal(sha256(input.bytes), entry.sha256, `${kind} evidence hash`);
    evidence[kind] = { ...input, path, relativePath: relative(fixture, path), sha256: entry.sha256 };
  }
  const check = () => {
    sameIdentity(rootStat, directory(root, uid));
    sameIdentity(runnerStat, directory(runnerTemp, uid));
    directories(runnerTemp, fixture, uid);
    sameIdentity(fixtureStat, directory(fixture, uid, true));
    const current = readOwned(fixture, provisioningPath, uid, 1_000_000);
    sameIdentity(receipt.stat, current.stat);
    assert.equal(sha256(current.bytes), sha256(receipt.bytes), 'provisioning receipt drift');
    for (const entry of Object.values(evidence)) {
      const current = readOwned(fixture, entry.path, uid, 8_000_000);
      sameIdentity(entry.stat, current.stat);
      assert.equal(sha256(current.bytes), entry.sha256, 'provisioning evidence drift');
    }
  };
  const provenance = { runnerTemp, fixture, destination, provisioningPath, sourceRoot: root, uid,
    runnerIdentity: identity(runnerStat), fixtureIdentity: identity(fixtureStat),
    provisioningIdentity: identity(receipt.stat), evidence: Object.fromEntries(Object.entries(evidence)
      .map(([kind, entry]) => [kind, { path: entry.path, relativePath: entry.relativePath, sha256: entry.sha256,
        identity: identity(entry.stat) }])) };
  return { root, uid, provisioning, provisioningBytes: receipt.bytes, evidence, provenance, check,
    createOutput() {
      check(); mkdirSync(destination, { mode: 0o700 });
      const outputStat = directory(destination, uid, true);
      provenance.outputIdentity = identity(outputStat);
      const files = new Map();
      const checkOutput = () => { check(); sameIdentity(outputStat, directory(destination, uid, true)); };
      return { out: destination, check: checkOutput, write(name, bytes) {
        assert.match(name, /^[a-z0-9][a-z0-9._-]*$/, 'fixed output filename required');
        checkOutput(); const path = resolve(destination, name);
        const previous = files.get(name);
        if (previous) { const current = lstatSync(path); regular(current, uid); sameIdentity(previous, current); }
        const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (previous ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
        try {
          const current = fstatSync(fd); regular(current, uid);
          if (previous) sameIdentity(previous, current);
          ftruncateSync(fd, 0); writeFileSync(fd, bytes); files.set(name, fstatSync(fd));
        } finally { closeSync(fd); }
      } };
    } };
}

/** All source inputs are regular owned files and match the clean committed tree,
 * including files git status could hide with assume-unchanged or skip-worktree. */
export function admitSourceInputs({ root, paths, committedBytes }) {
  const uid = process.getuid(); const rootStat = directory(root, uid);
  assert(paths.length > 0 && new Set(paths).size === paths.length, 'unique source inputs required');
  const inputs = Object.create(null), snapshots = new Map();
  for (const path of paths) {
    assert(typeof path === 'string' && path.length > 0 && !isAbsolute(path)
      && relative(root, resolve(root, path)) === path && inside(root, resolve(root, path)), 'canonical source input required');
    const input = readOwned(root, resolve(root, path), uid, 8_000_000);
    const hash = sha256(input.bytes);
    assert.equal(hash, sha256(committedBytes(path)), `source differs from committed input: ${path}`);
    inputs[path] = hash; snapshots.set(path, input);
  }
  const read = path => {
    assert(snapshots.has(path), 'unadmitted source input');
    sameIdentity(rootStat, directory(root, uid));
    const current = readOwned(root, resolve(root, path), uid, 8_000_000);
    sameIdentity(snapshots.get(path).stat, current.stat);
    assert.equal(sha256(current.bytes), inputs[path], `source input drift: ${path}`);
    return current.bytes;
  };
  return { inputs, read, check: () => { for (const path of paths) read(path); } };
}
