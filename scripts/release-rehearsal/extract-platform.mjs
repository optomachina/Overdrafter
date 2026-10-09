/** Cached, never-started platform source extraction. No import/plan side effects. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANDIDATE = 'bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b';
export const BASE_RUNNER = '2ba2839186dbadc6301d7ad84fd267d40f2cfb4c';
export const MANIFEST_SHA = '5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78';
export const LIMITS = Object.freeze({ totalMs: 1800000, cleanupMs: 60000, commandMs: 30000, graceMs: 2000,
  archive: 32 * 1024 ** 2, archives: 64 * 1024 ** 2, member: 4 * 1024 ** 2, selected: 32 * 1024 ** 2,
  metadata: 1024 ** 2, stderr: 256 * 1024, textTotal: 16 * 1024 ** 2, receipt: 2 * 1024 ** 2,
  commands: 64, headers: 1024, entries: 512, paxBody: 65536, paxTotal: 262144, paxRecords: 32 });
const SPEC = Object.freeze({
  auth: { repository: 'public.ecr.aws/supabase/gotrue', selector: 'public.ecr.aws/supabase/gotrue:v2.187.0', directory: '/usr/local/etc/auth/migrations', root: 'migrations', pattern: /^\d+_.+\.up\.sql$/ },
  storage: { repository: 'public.ecr.aws/supabase/storage-api', selector: 'public.ecr.aws/supabase/storage-api:v1.41.8', directory: '/app/migrations/tenant', root: 'tenant', pattern: /^\d+-.+\.sql$/ },
});
const SHA = /^[a-f0-9]{64}$/, ID = SHA, IMAGE = /^sha256:[a-f0-9]{64}$/;
const SELF = fileURLToPath(import.meta.url);
const hash = b => createHash('sha256').update(b).digest('hex');
const serial = v => JSON.stringify(v, null, 2) + '\n';
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function check(ok, code) { if (!ok) throw new Error(code); }
function exact(v, keys) { check(v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join('|') === [...keys].sort().join('|'), 'unexpected_fields'); }
function canonical(v) { return v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; }
export function configBinding(config) {
  const { schema, tools, images, parentDirectory, lease } = config;
  return hash(Buffer.from(canonical({ schema, tools, images, parentDirectory, lease })));
}
function utf8(b) { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
function manifest(bytes, pin) {
  check(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.metadata && hash(bytes) === pin, 'manifest_pin');
  const m = JSON.parse(utf8(bytes)); exact(m, ['auth', 'storage']);
  for (const [kind, count] of [['auth', 68], ['storage', 56]]) { check(Array.isArray(m[kind]) && m[kind].length === count, 'manifest_count'); validateExpected(kind, m[kind]); }
  return m;
}
function validateExpected(kind, entries) {
  check(Object.hasOwn(SPEC, kind) && Array.isArray(entries), 'invalid_kind_or_expected');
  const names = new Set(), ordinals = new Set();
  for (const e of entries) {
    exact(e, ['name', 'sha256']); check(typeof e.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(e.name) && SPEC[kind].pattern.test(e.name) && SHA.test(e.sha256), 'expected_entry');
    const ordinal = BigInt(e.name.match(/^\d+/)[0]).toString();
    check(!names.has(e.name) && !ordinals.has(ordinal), 'duplicate_expected'); names.add(e.name); ordinals.add(ordinal);
  }
  const sorted = [...names].sort(kind === 'auth' ? lexical : (a, b) => BigInt(a.match(/^\d+/)[0]) < BigInt(b.match(/^\d+/)[0]) ? -1 : 1);
  assert.deepEqual(entries.map(e => e.name), sorted, 'expected_order');
}
export function planExtraction({ manifestBytes }) {
  const m = manifest(manifestBytes, MANIFEST_SHA);
  return { schema: 'overdrafter.platform-extraction-plan.v1', candidateCommit: CANDIDATE, baseRunnerCommit: BASE_RUNNER,
    platformManifestSha256: MANIFEST_SHA, qualification: 'source-plan-only', runtime: 'not_run', commandsRun: 0,
    sources: ['auth', 'storage'].map(kind => ({ kind, ...SPEC[kind], pattern: SPEC[kind].pattern.source, files: m[kind] })), limits: LIMITS };
}
function tarString(b) {
  const end = b.indexOf(0); if (end < 0) return utf8(b);
  check(b.subarray(end).every(v => v === 0), 'tar_string_padding'); return utf8(b.subarray(0, end));
}
function octal(b) {
  check(b.every(v => v < 128), 'tar_base256');
  const value = b.toString('ascii').replace(/^[ \0]+|[ \0]+$/g, '');
  check(/^[0-7]+$/.test(value), 'tar_octal'); const n = Number.parseInt(value, 8); check(Number.isSafeInteger(n), 'tar_integer_overflow'); return n;
}
function safeName(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 512 && !/[\\\x00-\x1f\x7f:]/.test(value), 'tar_unsafe_path');
  if (value.startsWith('./')) value = value.slice(2);
  if (value.endsWith('/')) value = value.slice(0, -1);
  check(value && !value.split('/').some(p => ['', '.', '..'].includes(p)), 'tar_unsafe_path'); return value;
}
function memberName(value, kind, isDirectory) {
  check(isDirectory || !value.endsWith('/'), 'tar_regular_directory_suffix');
  const n = safeName(value), pieces = n.split('/');
  check(pieces[0] === SPEC[kind].root && (isDirectory ? pieces.length === 1 : pieces.length === 2), 'tar_wrong_root_or_depth'); return n;
}
function paxRecords(body) {
  const result = {}, allowed = new Set(['path', 'mtime', 'atime', 'ctime']); let at = 0, count = 0;
  while (at < body.length) {
    check(++count <= LIMITS.paxRecords, 'pax_record_limit'); const space = body.indexOf(32, at);
    check(space > at && space - at <= 6, 'pax_length'); const number = body.subarray(at, space).toString('latin1');
    check(/^[1-9][0-9]*$/.test(number), 'pax_length'); const length = Number(number), end = at + length;
    check(end <= body.length && end > space + 3 && body[end - 1] === 10, 'pax_record_boundary');
    const text = utf8(body.subarray(space + 1, end - 1)), eq = text.indexOf('='); check(eq > 0, 'pax_key');
    const key = text.slice(0, eq), value = text.slice(eq + 1);
    check(allowed.has(key) && !Object.hasOwn(result, key) && Buffer.byteLength(value) <= 4096, 'pax_key_or_value');
    if (key === 'path') safeName(value); else check(/^-?\d{1,16}(?:\.\d{1,9})?$/.test(value), 'pax_timestamp');
    result[key] = value; at = end;
  }
  return result;
}
/** A bounded validator, never an archive-driven filesystem extractor. */
export function parsePlatformArchive({ kind, archive, expected }) {
  validateExpected(kind, expected); check(Buffer.isBuffer(archive) && archive.length <= LIMITS.archive && archive.length % 512 === 0, 'archive_size_or_alignment');
  let at = 0, headers = 0, entries = 0, paxBytes = 0, pending = null, ended = false, selectedBytes = 0;
  const seen = new Set(), found = new Map();
  while (at < archive.length) {
    const h = archive.subarray(at, at + 512);
    if (h.every(v => v === 0)) {
      check(at + 1024 <= archive.length && archive.subarray(at).every(v => v === 0), 'tar_end_or_trailer');
      check(pending === null, 'pax_pending_at_end'); ended = true; break;
    }
    check(++headers <= LIMITS.headers, 'tar_header_limit');
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    check(octal(h.subarray(148, 156)) === sum, 'tar_checksum');
    const signature = h.subarray(257, 265).toString('latin1'); check(['ustar\0' + '00', 'ustar ' + ' \0'].includes(signature), 'tar_format');
    const size = octal(h.subarray(124, 136)), type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    check(['0', '5', 'x'].includes(type), 'tar_unsupported_type');
    check(tarString(h.subarray(157, 257)) === '', 'tar_link_field');
    const prefix = tarString(h.subarray(345, 500)), name = tarString(h.subarray(0, 100));
    const rawName = prefix ? prefix + '/' + name : name;
    const bodyStart = at + 512, next = bodyStart + Math.ceil(size / 512) * 512;
    check(size <= (type === 'x' ? LIMITS.paxBody : LIMITS.member) && next <= archive.length, 'tar_member_size');
    check(archive.subarray(bodyStart + size, next).every(v => v === 0), 'tar_body_padding');
    const body = archive.subarray(bodyStart, bodyStart + size); at = next;
    if (type === 'x') {
      check(pending === null, 'pax_consecutive'); safeName(rawName); paxBytes += size; check(paxBytes <= LIMITS.paxTotal, 'pax_total'); pending = paxRecords(body); continue;
    }
    check(++entries <= LIMITS.entries, 'tar_entry_limit');
    memberName(rawName, kind, type === '5');
    const resolved = memberName(pending?.path ?? rawName, kind, type === '5'); pending = null;
    check(!seen.has(resolved), 'tar_duplicate'); seen.add(resolved);
    if (type === '5') { check(size === 0, 'tar_directory_body'); continue; }
    const basename = resolved.split('/')[1];
    if (SPEC[kind].pattern.test(basename)) {
      selectedBytes += size; check(selectedBytes <= LIMITS.selected, 'selected_size'); found.set(basename, Buffer.from(body));
    }
  }
  check(ended, 'tar_missing_end');
  const ordered = [...found.keys()].sort(kind === 'auth' ? lexical : (a, b) => BigInt(a.match(/^\d+/)[0]) < BigInt(b.match(/^\d+/)[0]) ? -1 : 1);
  assert.deepEqual(ordered, expected.map(e => e.name), 'selected_file_set');
  for (const e of expected) check(hash(found.get(e.name)) === e.sha256, 'selected_hash');
  return { files: found, archiveSha256: hash(archive), archiveBytes: archive.length, selectedBytes, entries, headers, paxBytes };
}
function stableFile(file, max = LIMITS.receipt) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file && fs.realpathSync(file) === file, 'unsafe_file_path');
  const before = fs.lstatSync(file); check(before.isFile() && before.nlink === 1 && before.size <= max, 'unsafe_file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); check(stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size, 'file_changed'); const bytes = fs.readFileSync(fd); check(bytes.length <= max, 'file_grew'); return { bytes, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode }; }
  finally { fs.closeSync(fd); }
}
function directory(dir) {
  check(typeof dir === 'string' && path.isAbsolute(dir) && path.resolve(dir) === dir && fs.realpathSync(dir) === dir, 'unsafe_directory');
  const s = fs.lstatSync(dir); check(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'private_directory_required');
  for (let p = path.dirname(dir); ; p = path.dirname(p)) {
    const a = fs.lstatSync(p); check(a.isDirectory() && !a.isSymbolicLink() && (a.mode & 0o022) === 0 || a.isDirectory() && a.uid === 0 && (a.mode & 0o1000) !== 0, 'untrusted_ancestor');
    if (p === path.dirname(p)) break;
  }
  return { dev: s.dev, ino: s.ino };
}
function syncDir(dir) { const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeNew(file, bytes) {
  let writtenIdentity;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); const s = fs.fstatSync(fd); check(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && s.size === bytes.length, 'output_file_changed'); writtenIdentity = { dev: s.dev, ino: s.ino }; }
  finally { fs.closeSync(fd); }
  const got = stableFile(file, Math.max(bytes.length, LIMITS.receipt)); check(got.dev === writtenIdentity.dev && got.ino === writtenIdentity.ino && got.uid === process.getuid() && (got.mode & 0o777) === 0o600 && hash(got.bytes) === hash(bytes), 'output_bytes_changed');
}
/** Testable bounded binary transport. Production argv is constructed internally. */
export function executeBinary(binary, argv, { cwd, env, timeoutMs, signal, stdoutLimit, stderrLimit = LIMITS.stderr }) {
  return new Promise(resolve => {
    let done = false, failure = null, timer, killTimer, stdoutBytes = 0, stderrBytes = 0;
    const chunks = { stdout: [], stderr: [] }, started = performance.now();
    if (signal?.aborted) return resolve({ status: null, signal: null, failure: 'aborted', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), elapsedMs: 0 });
    const child = spawn(binary, argv, { cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (status, sig) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (sig != null) failure ??= 'signalled'; else if (status === null) failure ??= 'exit_unconfirmed';
      resolve({ status, signal: sig, failure, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), elapsedMs: performance.now() - started });
    };
    const stop = reason => {
      if (failure || done) return; failure = reason;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Require close or explicit uncertainty. */ }
      killTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, 'unconfirmed'); }, LIMITS.graceMs);
    };
    const abort = () => stop('aborted'); signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const which of ['stdout', 'stderr']) child[which].on('data', b => {
      if (done || failure) return;
      const count = which === 'stdout' ? stdoutBytes : stderrBytes, limit = which === 'stdout' ? stdoutLimit : stderrLimit;
      const take = b.subarray(0, Math.max(0, limit - count)); chunks[which].push(take);
      if (which === 'stdout') stdoutBytes += take.length; else stderrBytes += take.length;
      if (count + b.length > limit) stop('output_limit');
    });
    child.on('error', () => { failure = 'spawn_error'; finish(null, null); }); child.on('close', finish);
  });
}
// Projection-only inspection: never request Config.Env or arbitrary existing-resource data.
const IMAGE_INSPECT = '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}},"Entrypoint":{{json .Config.Entrypoint}},"Cmd":{{json .Config.Cmd}},"VolumeCount":{{len .Config.Volumes}},"ConflictingOwner":{{if or (index .Config.Labels "ovd591.owner") (index .Config.Labels "ovd658.owner") (index .Config.Labels "ovd659.owner")}}true{{else}}false{{end}}}';
const OWNED_INSPECT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"ConfigImage":{{json .Config.Image}},"Owner":{{json (index .Config.Labels "ovd659.owner")}},"Source":{{json (index .Config.Labels "ovd659.source")}},"Token":{{json (index .Config.Labels "ovd659.fixture")}},"Entrypoint":{{json .Config.Entrypoint}},"Cmd":{{json .Config.Cmd}},"VolumeCount":{{len .Config.Volumes}},"Status":{{json .State.Status}},"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}},"RestartCount":{{json .RestartCount}},"MountCount":{{len .Mounts}},"BindCount":{{len .HostConfig.Binds}},"HostMountCount":{{len .HostConfig.Mounts}},"NetworkMode":{{json .HostConfig.NetworkMode}},"Dns":{{json .HostConfig.Dns}},"Privileged":{{json .HostConfig.Privileged}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"CapAdd":{{json .HostConfig.CapAdd}},"CapDrop":{{json .HostConfig.CapDrop}},"Devices":{{json .HostConfig.Devices}},"DeviceRequests":{{json .HostConfig.DeviceRequests}},"PortBindings":{{json .HostConfig.PortBindings}},"PidMode":{{json .HostConfig.PidMode}},"IpcMode":{{json .HostConfig.IpcMode}},"UTSMode":{{json .HostConfig.UTSMode}},"UsernsMode":{{json .HostConfig.UsernsMode}},"NanoCpus":{{json .HostConfig.NanoCpus}},"Memory":{{json .HostConfig.Memory}},"PidsLimit":{{json .HostConfig.PidsLimit}},"RestartPolicy":{{json .HostConfig.RestartPolicy.Name}},"SecurityOpt":{{json .HostConfig.SecurityOpt}},"Tmpfs":{{json .HostConfig.Tmpfs}}}';
function admitted(options, fake, fakeManifest) {
  exact(options, ['manifestBytes', 'config']); check(Buffer.isBuffer(options.manifestBytes), 'manifest_bytes'); const config = structuredClone(options.config), bytes = Buffer.from(options.manifestBytes);
  const m = manifest(bytes, fake ? hash(fakeManifest) : MANIFEST_SHA);
  exact(config, ['schema', 'tools', 'images', 'parentDirectory', 'lease', 'admission']); check(config.schema === 'overdrafter.platform-extraction-config.v1', 'config_schema');
  const { tools, images, admission: a, lease } = config;
  exact(tools, ['docker', 'socket']); exact(tools.docker, ['path', 'sha256']); exact(images, ['auth', 'storage']); exact(lease, ['path', 'sha256']);
  exact(a, ['schema', 'qualification', 'candidateCommit', 'baseRunnerCommit', 'extractorCommit', 'extractorSha256', 'configBindingSha256', 'platformManifestSha256', 'leaseSha256', 'expiresAt']);
  check(a.schema === 'overdrafter.platform-extraction-admission.v1' && a.qualification === 'authentic-platform-source-only' && a.candidateCommit === CANDIDATE && a.baseRunnerCommit === BASE_RUNNER && /^[a-f0-9]{40}$/.test(a.extractorCommit), 'admission_identity');
  check(hash(stableFile(SELF).bytes) === a.extractorSha256 && configBinding(config) === a.configBindingSha256 && a.platformManifestSha256 === hash(bytes) && a.leaseSha256 === lease.sha256, 'admission_hash');
  check(SHA.test(tools.docker.sha256) && hash(stableFile(tools.docker.path, 128 * 1024 ** 2).bytes) === tools.docker.sha256, 'docker_hash');
  check(/^\/[A-Za-z0-9_./-]+$/.test(tools.socket) && path.isAbsolute(tools.socket) && fs.realpathSync(tools.socket) === tools.socket, 'socket_path'); const s = fs.lstatSync(tools.socket); check(fake ? s.isFile() : s.isSocket(), 'local_socket');
  for (const kind of ['auth', 'storage']) {
    const i = images[kind]; exact(i, ['id', 'digest', 'entrypoint', 'cmd']);
    check(IMAGE.test(i.id) && new RegExp('^' + SPEC[kind].repository.replaceAll('.', '\\.') + '@sha256:[a-f0-9]{64}$').test(i.digest), 'image_identity');
    for (const v of [i.entrypoint, i.cmd]) check(v === null || Array.isArray(v) && v.every(x => typeof x === 'string'), 'image_command');
  }
  const lf = stableFile(lease.path); check(lf.uid === process.getuid() && (lf.mode & 0o077) === 0 && hash(lf.bytes) === lease.sha256, 'lease_file');
  const l = JSON.parse(utf8(lf.bytes)); exact(l, ['schema', 'ownerUnit', 'host', 'socket', 'token', 'expiresAt', 'exclusive']);
  check(l.schema === 'overdrafter.local-fixture-exclusive-lease.v1' && l.ownerUnit === 'extraction659runtime' && l.host === 'saved-cloud-20261008' && l.socket === tools.socket && /^[a-f0-9]{32}$/.test(l.token) && l.exclusive === true, 'lease_identity');
  for (const date of [a.expiresAt, l.expiresAt]) check(Number.isFinite(Date.parse(date)) && Date.parse(date) > Date.now(), 'expired');
  check(fake || process.platform === 'linux' && process.arch === 'x64', 'host_platform');
  return { config, manifest: m, manifestBytes: bytes, parentIdentity: directory(config.parentDirectory), leaseIdentity: lf, socketIdentity: { dev: s.dev, ino: s.ino }, leaseContents: l };
}
export function createPlatformExtractor(options) { return construct(options, null); }
export function createPlatformExtractorForTests(options, dependencies) {
  exact(dependencies, ['execute', 'now', 'manifestBytes']); check(typeof dependencies.execute === 'function' && dependencies.execute !== executeBinary && typeof dependencies.now === 'function' && Buffer.isBuffer(dependencies.manifestBytes), 'fake_dependencies');
  return construct(options, dependencies);
}
function construct(options, dependencies) {
  const fake = dependencies !== null, o = admitted(options, fake, dependencies?.manifestBytes), c = o.config;
  const transport = dependencies?.execute ?? executeBinary, clock = dependencies?.now ?? (() => performance.now());
  const controller = new AbortController(); let executed = false, previous = -Infinity;
  function now() { const t = clock(); check(Number.isFinite(t) && t >= previous, 'monotonic_clock'); previous = t; return t; }
  async function execute() {
    check(!executed, 'single_use'); executed = true;
    const totalDeadline = now() + LIMITS.totalMs, workDeadline = totalDeadline - LIMITS.cleanupMs;
    const token = randomBytes(16).toString('hex'); let root, rootIdentity, environmentIdentities, active = null, sequence = 0, commands = 0, textTotal = 0, archiveTotal = 0, selectedTotal = 0, cleanupStarted = false, cleanupDeadline;
    const report = { schema: 'overdrafter.platform-extraction-result.v1', status: 'running', qualification: fake ? 'fake-transport-only' : 'authentic-platform-source-only',
      candidateCommit: CANDIDATE, baseRunnerCommit: BASE_RUNNER, extractorCommit: c.admission.extractorCommit, extractorSha256: c.admission.extractorSha256,
      manifestSha256: hash(o.manifestBytes), configBindingSha256: c.admission.configBindingSha256, leaseSha256: c.lease.sha256,
      runToken: token, deadlines: { totalDeadline, workDeadline }, images: {}, containers: [], archives: [], files: [], receipts: [], cleanup: { status: 'not_started' }, publishedBundle: null };
    function ownership(cleanup = false) {
      assert.deepEqual(directory(c.parentDirectory), o.parentIdentity, 'parent_replaced');
      if (root) assert.deepEqual(directory(root), rootIdentity, 'run_root_replaced');
      if (environmentIdentities) for (const [name, identity] of Object.entries(environmentIdentities)) {
        const dir = path.join(root, name); assert.deepEqual(directory(dir), identity, 'environment_directory_replaced'); check(fs.readdirSync(dir).length === 0, 'environment_not_empty');
      }
      const lease = stableFile(c.lease.path); check(lease.dev === o.leaseIdentity.dev && lease.ino === o.leaseIdentity.ino && hash(lease.bytes) === c.lease.sha256 && lease.uid === process.getuid() && (lease.mode & 0o077) === 0, 'lease_drift');
      if (!cleanup) { check(Date.parse(c.admission.expiresAt) > Date.now() && Date.parse(o.leaseContents.expiresAt) > Date.now(), 'expired'); check(!controller.signal.aborted, 'aborted'); }
    }
    function sourceIdentity() {
      check(hash(stableFile(c.tools.docker.path, 128 * 1024 ** 2).bytes) === c.tools.docker.sha256 && hash(stableFile(SELF).bytes) === c.admission.extractorSha256, 'tool_or_source_drift');
    }
    function persist() {
      if (!root) return; ownership(true); const bytes = Buffer.from(serial(report)); check(bytes.length <= LIMITS.receipt, 'receipt_limit');
      const temp = path.join(root, `state-${++sequence}.tmp`); writeNew(temp, bytes); fs.renameSync(temp, path.join(root, 'state.json')); syncDir(root);
    }
    async function call(args, { binary = false, cleanup = false, tolerate = false } = {}) {
      ownership(cleanup); check(cleanup || !cleanupStarted, 'work_after_cleanup');
      const deadline = cleanup ? cleanupDeadline : workDeadline;
      check(Number.isFinite(deadline), 'cleanup_not_started');
      const socket = fs.lstatSync(c.tools.socket); check(fs.realpathSync(c.tools.socket) === c.tools.socket && socket.dev === o.socketIdentity.dev && socket.ino === o.socketIdentity.ino && (fake ? socket.isFile() : socket.isSocket()), 'socket_drift');
      sourceIdentity();
      // Synchronous identity reads may consume time or expose cancellation.
      if (!cleanup) {
        check(Date.parse(c.admission.expiresAt) > Date.now() && Date.parse(o.leaseContents.expiresAt) > Date.now(), 'expired');
        check(!controller.signal.aborted, 'aborted');
      }
      const remaining = deadline - now(); check(remaining > LIMITS.graceMs && ++commands <= LIMITS.commands, 'deadline_or_command_limit');
      const argv = ['--host', 'unix://' + c.tools.socket, ...args], budget = Math.min(LIMITS.commandMs - LIMITS.graceMs, remaining - LIMITS.graceMs);
      const r = await transport(c.tools.docker.path, argv, { cwd: root, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(root, 'home'), DOCKER_CONFIG: path.join(root, 'docker-config'), LANG: 'C', LC_ALL: 'C' }, timeoutMs: budget, signal: cleanup ? undefined : controller.signal, stdoutLimit: binary ? LIMITS.archive : LIMITS.metadata, stderrLimit: LIMITS.stderr });
      check(Buffer.isBuffer(r.stdout) && Buffer.isBuffer(r.stderr), 'binary_transport_contract');
      check(r.stdout.length <= (binary ? LIMITS.archive : LIMITS.metadata) && r.stderr.length <= LIMITS.stderr, 'transport_output_limit');
      textTotal += r.stderr.length + (binary ? 0 : r.stdout.length); if (binary) archiveTotal += r.stdout.length;
      check(textTotal <= LIMITS.textTotal && archiveTotal <= LIMITS.archives, 'aggregate_output_limit');
      const receipt = { argv, status: r.status, signal: r.signal, failure: r.failure, stdoutBytes: r.stdout.length, stdoutSha256: hash(r.stdout), stderrBytes: r.stderr.length, stderrSha256: hash(r.stderr), elapsedMs: r.elapsedMs };
      // Do not persist raw inspect/error text; explicit projected parsed fields suffice.
      report.receipts.push(receipt); persist();
      check(now() <= deadline, 'deadline_exhausted');
      check(tolerate || r.status === 0 && r.signal == null && !r.failure, 'command_failed'); return r;
    }
    async function ids(cleanup = false) {
      const r = await call(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}'], { cleanup });
      const list = utf8(r.stdout).trim().split(/\r?\n/).filter(Boolean); check(list.every(v => ID.test(v)) && new Set(list).size === list.length, 'invalid_inventory'); return list;
    }
    async function exclusive() {
      check((await ids()).length === 0, 'preexisting_container');
      for (const label of ['ovd591.owner', 'ovd658.owner', 'ovd659.owner']) {
        const r = await call(['network', 'ls', '--no-trunc', '--filter', 'label=' + label, '--format', '{{.ID}}']); check(utf8(r.stdout).trim() === '', 'fixture_network_conflict');
      }
    }
    async function inspect(t, cleanup = false) {
      // Unverified acknowledgments are never authoritative during cleanup.
      const expectedId = t.id ?? (cleanup && t.uncertain ? null : t.acknowledgedId);
      const r = await call(['container', 'inspect', '--format', OWNED_INSPECT, expectedId ?? t.name], { cleanup }); const v = JSON.parse(utf8(r.stdout));
      check(ID.test(v.Id) && (!expectedId || expectedId === v.Id) && v.Name === '/' + t.name && v.Image === c.images[t.kind].id && v.ConfigImage === v.Image && v.Owner === 'platform-extraction' && v.Source === CANDIDATE && v.Token === token, 'container_owner');
      check(v.Status === 'created' && v.Running === false && /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(v.StartedAt) && v.RestartCount === 0, 'container_was_started');
      assert.deepEqual(v.Entrypoint, c.images[t.kind].entrypoint); assert.deepEqual(v.Cmd, c.images[t.kind].cmd);
      check([v.VolumeCount, v.MountCount, v.BindCount, v.HostMountCount].every(n => n === 0), 'container_mount');
      check(v.NetworkMode === 'none' && v.Privileged === false && v.ReadonlyRootfs === true && v.NanoCpus === 1e9 && v.Memory === 512 * 1024 ** 2 && v.PidsLimit === 64 && v.RestartPolicy === 'no', 'container_policy');
      assert.deepEqual(v.Dns, ['127.0.0.1']); assert.deepEqual(v.CapDrop, ['ALL']);
      for (const key of ['CapAdd', 'Devices', 'DeviceRequests']) check(v[key] == null || Array.isArray(v[key]) && v[key].length === 0, 'container_privilege');
      for (const key of ['PortBindings', 'Tmpfs']) check(v[key] == null || typeof v[key] === 'object' && Object.keys(v[key]).length === 0, 'container_port_or_tmpfs');
      for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode']) check(typeof v[key] === 'string' && !v[key].includes('host') && !v[key].startsWith('container:'), 'container_namespace');
      check(Array.isArray(v.SecurityOpt) && v.SecurityOpt.length === 1 && ['no-new-privileges', 'no-new-privileges:true'].includes(v.SecurityOpt[0]), 'container_security');
      t.id = v.Id; persist(); return v;
    }
    async function remove(t, cleanup) {
      const inventory = await ids(cleanup);
      if (!t.uncertain && t.id && !inventory.includes(t.id)) {
        t.cleanup = 'observed_absent'; persist(); return;
      }
      if (t.uncertain && inventory.length === 0) throw new Error('creation_unconfirmed');
      await inspect(t, cleanup);
      const r = await call(['rm', t.id], { cleanup, tolerate: true }); const after = await ids(cleanup);
      t.absentObserved = !after.includes(t.id); t.cleanup = r.status === 0 && !r.failure && r.signal == null && t.absentObserved ? 'removed_and_observed_absent' : 'failed'; persist();
      check(t.cleanup !== 'failed', 'removal_unconfirmed'); check(!t.uncertain, 'creation_unconfirmed');
    }
    const outputs = new Map();
    try {
      ownership(); root = fs.mkdtempSync(path.join(c.parentDirectory, 'ovd659-')); fs.chmodSync(root, 0o700); rootIdentity = directory(root); report.runDirectory = root;
      for (const d of ['home', 'docker-config']) fs.mkdirSync(path.join(root, d), { mode: 0o700 });
      environmentIdentities = Object.fromEntries(['home', 'docker-config'].map(d => [d, directory(path.join(root, d))])); persist();
      await exclusive();
      for (const kind of ['auth', 'storage']) {
        const r = await call(['image', 'inspect', '--format', IMAGE_INSPECT, c.images[kind].id]); const v = JSON.parse(utf8(r.stdout));
        check(v.Id === c.images[kind].id && v.Os === 'linux' && v.Architecture === 'amd64' && Array.isArray(v.RepoDigests) && v.RepoDigests.includes(c.images[kind].digest) && v.VolumeCount === 0 && v.ConflictingOwner === false, 'cached_image_policy');
        assert.deepEqual(v.Entrypoint, c.images[kind].entrypoint); assert.deepEqual(v.Cmd, c.images[kind].cmd); report.images[kind] = v; persist();
      }
      for (const kind of ['auth', 'storage']) {
        await exclusive();
        active = { kind, name: `ovd659-${token}-${kind}`, id: null, acknowledgedId: null, attempted: true, uncertain: true, cleanup: 'pending' };
        report.containers.push(active); persist(); // Durable intent precedes create, including ambiguous acknowledgments.
        const r = await call(['create', '--pull=never', '--name', active.name, '--network', 'none', '--dns', '127.0.0.1', '--label', 'ovd659.owner=platform-extraction', '--label', 'ovd659.source=' + CANDIDATE, '--label', 'ovd659.fixture=' + token,
          '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--restart', 'no', c.images[kind].id]);
        const id = utf8(r.stdout).trim(); check(ID.test(id), 'create_ack'); active.acknowledgedId = id; persist();
        await inspect(active); active.uncertain = false; persist();
        assert.deepEqual(await ids(), [active.id], 'concurrent_container');
        const archive = await call(['cp', active.id + ':' + SPEC[kind].directory, '-'], { binary: true });
        const parsed = parsePlatformArchive({ kind, archive: archive.stdout, expected: o.manifest[kind] }); selectedTotal += parsed.selectedBytes; check(selectedTotal <= LIMITS.selected, 'aggregate_selected_size');
        outputs.set(kind, parsed.files); const { files: _files, ...archiveReceipt } = parsed; report.archives.push({ kind, ...archiveReceipt });
        report.files.push(...o.manifest[kind].map(e => ({ kind, ...e, bytes: parsed.files.get(e.name).length }))); persist();
        await inspect(active); await remove(active, false); active = null;
      }
      ownership(); check(now() < workDeadline, 'publication_deadline');
      report.cleanup = { status: 'removed_and_observed_absent' }; persist();
      const stage = path.join(root, 'staging'); fs.mkdirSync(stage, { mode: 0o700 }); const stageIdentity = directory(stage);
      fs.mkdirSync(path.join(stage, 'platform'), { mode: 0o700 });
      for (const kind of ['auth', 'storage']) {
        const dir = path.join(stage, 'platform', kind); fs.mkdirSync(dir, { mode: 0o700 }); const identity = directory(dir);
        for (const e of o.manifest[kind]) { ownership(); assert.deepEqual(directory(stage), stageIdentity); assert.deepEqual(directory(dir), identity); check(now() < workDeadline, 'publication_deadline'); writeNew(path.join(dir, e.name), outputs.get(kind).get(e.name)); }
        syncDir(dir);
      }
      writeNew(path.join(stage, 'platform-manifest.json'), o.manifestBytes);
      const receiptBytes = Buffer.from(serial({ ...report, status: 'verified_before_publication' })); check(receiptBytes.length <= LIMITS.receipt, 'receipt_limit'); writeNew(path.join(stage, 'extraction-receipt.json'), receiptBytes);
      syncDir(path.join(stage, 'platform')); syncDir(stage); ownership(); sourceIdentity(); assert.deepEqual(directory(stage), stageIdentity); check(now() < workDeadline, 'publication_deadline');
      const target = path.join(root, 'bundle'); check(!fs.existsSync(target), 'publication_collision');
      report.publication = 'rename_attempted'; report.intendedBundle = target; persist();
      // Identity reads and durable intent persistence may consume admission or time.
      check(Date.parse(c.admission.expiresAt) > Date.now() && Date.parse(o.leaseContents.expiresAt) > Date.now(), 'expired');
      check(!controller.signal.aborted, 'aborted'); check(now() < workDeadline, 'publication_deadline');
      fs.renameSync(stage, target); syncDir(root); ownership(); sourceIdentity(); check(now() < workDeadline, 'publication_deadline');
      report.publishedBundle = target; report.receiptSha256 = hash(receiptBytes); report.status = 'completed'; report.publication = 'published'; persist(); ownership(); check(now() < workDeadline, 'publication_deadline');
    } catch (error) {
      report.status = 'failed'; report.error = error.message; report.publishedBundle = null;
      if (report.publication) report.publication = 'publication_unconfirmed';
      cleanupStarted = true;
      const cleanupStart = now(); cleanupDeadline = Math.min(cleanupStart + LIMITS.cleanupMs, totalDeadline);
      report.deadlines.cleanupStart = cleanupStart; report.deadlines.cleanupDeadline = cleanupDeadline;
      if (active) {
        try { await remove(active, true); report.cleanup = { status: 'removed_and_observed_absent' }; }
        catch (cleanupError) { report.cleanup = { status: 'unconfirmed', reason: cleanupError.message, id: active.id, name: active.name, retainExclusiveLease: true }; }
      } else if (report.cleanup.status === 'not_started') report.cleanup = { status: 'no_pending_container' };
      try { persist(); } catch (stateError) { report.statePersistenceError = stateError.message; }
    }
    return structuredClone(report);
  }
  return Object.freeze({ execute, abort: () => controller.abort() });
}
export async function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; check(['--manifest', '--config', '--execute'].includes(k) && !flags.has(k), 'unknown_or_duplicate_flag'); flags.set(k, k === '--execute' ? true : argv[++i]); }
  check(typeof flags.get('--manifest') === 'string', 'manifest_required'); const manifestBytes = stableFile(flags.get('--manifest'), LIMITS.metadata).bytes;
  if (!flags.has('--execute')) { check(!flags.has('--config'), 'config_requires_execute'); console.log(serial(planExtraction({ manifestBytes }))); return 0; }
  check(typeof flags.get('--config') === 'string', 'config_required'); const config = JSON.parse(utf8(stableFile(flags.get('--config')).bytes));
  const report = await createPlatformExtractor({ manifestBytes, config }).execute(); console.log(serial(report)); return report.status === 'completed' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
