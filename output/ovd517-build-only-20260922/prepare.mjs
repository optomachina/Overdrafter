import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Frozen local evidence generation only. No cloud, registry, or Docker calls.
const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
const sha = '7da20710b25a6a30d0f9ac59e88e00f685defc67';
const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

ensure(git('rev-parse', 'HEAD').toString().trim() === sha, 'source_sha_changed');
ensure(git('diff', '--quiet').length === 0 && git('diff', '--cached', '--quiet').length === 0,
  'tracked_source_changed');
const all = git('ls-tree', '-rz', `${sha}:worker`).toString().split('\0').filter(Boolean).map(line => {
  const [metadata, file] = line.split('\t');
  const [mode, type, gitBlob] = metadata.split(' ');
  return { path: file, mode, type, gitBlob };
});
const root = new Set(['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'scripts/install-camoufox.mjs']);
const selected = all.filter(item => root.has(item.path) ||
  (item.path.startsWith('src/') && /\.(ts|json)$/.test(item.path) && !item.path.endsWith('.test.ts') &&
    item.path !== 'src/adapters/providerEnvelopeContractTest.ts')).sort((a, b) => a.path.localeCompare(b.path));
ensure([...root].every(name => selected.some(item => item.path === name)), 'docker_input_missing');
for (const item of selected) {
  ensure(item.type === 'blob' && ['100644', '100755'].includes(item.mode), 'nonregular_source_entry');
  ensure(!/(^|\/)(\.env|state|tmp|node_modules|dist)(\/|$)|\.(step|stp|pdf|zip|sqlite|pem|key)$/i.test(item.path),
    'excluded_source_category');
  const bytes = git('cat-file', 'blob', item.gitBlob);
  ensure(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(bytes.toString()),
    'secret_marker_found');
  item.bytes = bytes.length;
  item.sha256 = digest(bytes);
  delete item.type;
}
const source = {
  schema: 'ovd419-minimal-source-v2', sourceSha: sha,
  repositoryTree: git('rev-parse', `${sha}^{tree}`).toString().trim(),
  workerTree: git('rev-parse', `${sha}:worker`).toString().trim(),
  selection: 'Six Docker inputs, including scripts/install-camoufox.mjs, and tsconfig-included src TypeScript/JSON; no fixtures',
  files: selected,
};
const manifest = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
writeFileSync(path.join(directory, 'source-manifest.json'), manifest, { flag: 'wx' });
const archivePath = path.join(directory, 'worker-source.tar.gz');
git('archive', '--format=tar.gz', `--output=${archivePath}`, `${sha}:worker`, ...selected.map(item => item.path));
const archive = readFileSync(archivePath);
const critical = [];
const walk = dir => {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) walk(file);
    else critical.push({ path: path.relative(path.join(repo, 'worker'), file), bytes: st.size,
      sha256: digest(readFileSync(file)) });
  }
};
for (const name of ['package.json', 'package-lock.json']) {
  const bytes = readFileSync(path.join(repo, 'worker', name));
  critical.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
}
walk(path.join(repo, 'worker/dist'));
critical.sort((a, b) => a.path.localeCompare(b.path));
const criticalBytes = Buffer.from(`${JSON.stringify(critical, null, 2)}\n`);
writeFileSync(path.join(directory, 'expected-critical-files.json'), criticalBytes, { flag: 'wx' });
const evidence = {
  sourceSha: sha, repositoryTree: source.repositoryTree, workerTree: source.workerTree,
  sourceFiles: selected.length, archiveBytes: archive.length, archiveSha256: digest(archive),
  archiveMd5Base64: createHash('md5').update(archive).digest('base64'),
  manifestSha256: digest(manifest), criticalFileCount: critical.length,
  expectedCriticalFilesSha256: digest(criticalBytes), excludedTrackedWorkerFiles: all.length - selected.length,
};
writeFileSync(path.join(directory, 'source-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
