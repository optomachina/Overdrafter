import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { validateImage, validateMetadata, containerArgs, SOURCE_SHA, IMAGE_REPO } from './inspect-local-image.mjs';
const require = createRequire(import.meta.url);
const { validateManifest, packageVersionMatches, assertNoMmdb } = require('./image-inspector.cjs');
const image = `${IMAGE_REPO}@sha256:${'a'.repeat(64)}`;
const goodMetadata = () => [{ Os: 'linux', Architecture: 'amd64', RepoDigests: [image],
  Id: `sha256:${'b'.repeat(64)}`, Config: { Env: [`WORKER_BUILD_VERSION=${SOURCE_SHA}`] } }];
test('package metadata allows exactly one vendor v prefix without hiding version differences', () => {
  for (const observed of ['1.59.4', 'v1.59.4']) assert.equal(packageVersionMatches(observed, '1.59.4'), true);
  assert.equal(packageVersionMatches('v1.59.4-beta.2+build.9', '1.59.4-beta.2+build.9'), true);
  for (const observed of ['1.59.5', 'v1.59.5', 'vv1.59.4', 'V1.59.4', '=1.59.4', 'npm:1.59.4',
    ' 1.59.4', '1.59.4 ', '1.59.4\n', 'v1.59.4\r\n', '1.59.4\nother',
    '01.59.4', '1.59', '1.59.4-beta.2', '1.59.4+build.9', undefined]) {
    assert.equal(packageVersionMatches(observed, '1.59.4'), false, String(observed));
  }
  assert.equal(packageVersionMatches('1.59.4-beta.02', '1.59.4-beta.02'), false);
  assert.equal(packageVersionMatches('1.59.4\n', '1.59.4\n'), false);
  assert.equal(packageVersionMatches('v1.59.4', 'v1.59.4'), false);
  assert.equal(packageVersionMatches('v1.59.4-beta.2', '1.59.4-beta.3'), false);
});
test('exact digest scope rejects tags, extra arguments, wrong registry and malformed digests', () => {
  assert.equal(validateImage(image), image);
  for (const bad of [IMAGE_REPO, `${IMAGE_REPO}:tag`, image + 'x', image.replace('us-west1', 'us-east1'),
    image.replace(/a+$/, 'A'.repeat(64)), `${image}\n`, undefined]) assert.throws(() => validateImage(bad));
});
test('local metadata must independently match full SHA, platform, digest and no injection', () => {
  assert.equal(validateMetadata(goodMetadata(), image).sourceSha, SOURCE_SHA);
  for (const edit of [row => row.Architecture = 'arm64', row => row.Os = 'darwin',
    row => row.RepoDigests = [], row => row.Config.Env = ['WORKER_BUILD_VERSION=unknown'],
    row => row.Config.Env.push(`WORKER_BUILD_VERSION=${SOURCE_SHA}`),
    row => row.Config.Env.push('NODE_OPTIONS=--require=unsafe'), row => row.Config.Volumes = { '/data': {} }]) {
    const rows = goodMetadata(); edit(rows[0]); assert.throws(() => validateMetadata(rows, image));
  }
});
test('container args fix all isolation controls and never inject build env or mounts', () => {
  const args = containerArgs(image, 'ovd517-inspect-11111111-1111-1111-1111-111111111111', 'CODE');
  for (const token of ['--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
    '--entrypoint=node', '--no-healthcheck', '--rm']) assert.ok(args.includes(token));
  assert.equal(args[1], 'unix:///var/run/docker.sock');
  assert.ok(!args.slice(0, args.indexOf(image)).some(arg => /^(--env|-e|--mount|--volume|-v)$/.test(arg)),
    'no Docker environment or mount options; Node -e follows the image argument');
});
test('manifest requires exact count, package metadata and no traversal/duplicates', () => {
  const manifest = JSON.parse(readFileSync(new URL('expected-critical-files.json', import.meta.url), 'utf8'));
  assert.equal(validateManifest(manifest).length, 107);
  for (const edit of [rows => rows.pop(), rows => rows[0].path = '../secret', rows => rows[0] = rows[1],
    rows => rows[0].sha256 = 'wrong', rows => rows[0].bytes = -1]) {
    const rows = structuredClone(manifest); edit(rows); assert.throws(() => validateManifest(rows));
  }
});
test('offline filesystem scan rejects nested mmdb without following unrelated files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ovd517-inspector-'));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'safe.txt'), 'safe');
  assert.doesNotThrow(() => assertNoMmdb([root]));
  writeFileSync(join(root, 'nested', 'GeoLite2-City.MMDB'), 'fake');
  assert.throws(() => assertNoMmdb([root]), /mmdb_present/);
});
