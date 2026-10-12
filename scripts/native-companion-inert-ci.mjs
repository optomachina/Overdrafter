import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suites = Object.freeze([
  ['test-state.ps1', 'overdrafter.companion-state-test.v1', 'assertions'],
  ['test-boundaries.ps1', 'overdrafter.companion-boundary-test.v1', 'assertions'],
  ['test-task.ps1', 'overdrafter.companion-task-test.v1', 'assertions'],
  ['test-output-replay.ps1', 'overdrafter.companion-output-replay-test.v1', 'checks'],
]);

// Never search PATH or the checkout for Git. An explicitly configured path is
// authoritative: a missing/invalid override refuses rather than falling back.
export function resolveGitExecutable({ platform = process.platform, env = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'git.exe' : 'git';
  const candidates = env.OVD_GIT_EXECUTABLE !== undefined ? [env.OVD_GIT_EXECUTABLE]
    : platform === 'win32'
      ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
      : ['/usr/bin/git', '/usr/local/bin/git'];
  for (const candidate of candidates) {
    if (!paths.isAbsolute(candidate) || paths.basename(candidate).toLowerCase() !== name ||
        paths.normalize(candidate) !== candidate) throw new Error('Git executable must be a normalized absolute Git file path.');
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Git executable must be a regular non-symlink file.');
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' || env.OVD_GIT_EXECUTABLE !== undefined) throw error;
    }
  }
  throw new Error('No Git executable at the fixed installation paths; set OVD_GIT_EXECUTABLE explicitly.');
}

export const runtimeProbeArgs = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  "[Console]::Error.WriteLine('OVD_PROBE:entered'); $ErrorActionPreference='Stop'; " +
  "$versionObject=$PSVersionTable.PSVersion; $edition=$PSVersionTable.PSEdition; $x64=[Environment]::Is64BitProcess; " +
  "if ($versionObject -isnot [System.Version] -or $edition -isnot [string] -or $edition -cne 'Desktop') { throw 'Unsupported runtime metadata.' }; " +
  "$version=$versionObject.ToString(); [Console]::Error.WriteLine('OVD_PROBE:runtime-collected'); " +
  "if ($version.Length -gt 43 -or -not [regex]::IsMatch($version,'\\A[0-9]{1,10}(\\.[0-9]{1,10}){1,3}\\z')) { throw 'Invalid runtime version.' }; " +
  "$invariant=[System.Globalization.CultureInfo]::InvariantCulture; $x64Json=if ($x64) { 'true' } else { 'false' }; " +
  "$json='{\"edition\":\"' + $edition + '\",\"version\":\"' + $version + '\",\"major\":' + $versionObject.Major.ToString($invariant) + ',\"minor\":' + $versionObject.Minor.ToString($invariant) + ',\"x64\":' + $x64Json + '}'; " +
  "[Console]::Out.WriteLine($json); [Console]::Error.WriteLine('OVD_PROBE:json-written')"]);

export function runtimeProbeDiagnostics(execution) {
  const lines = execution.stderr.split(/\r?\n/);
  const stages = ['entered', 'runtime-collected', 'json-written'].filter((stage) => lines.includes(`OVD_PROBE:${stage}`));
  return { stages, lastObservedStage: stages.at(-1) ?? 'command-entry-not-observed',
    failure: execution.failure, exitCode: execution.exitCode, signal: execution.signal,
    elapsedMs: execution.elapsedMs, spawned: execution.spawned, spawnErrorCode: execution.spawnErrorCode };
}

export function validateRuntimeProbe(execution) {
  if (execution.failure || execution.exitCode !== 0 || execution.signal) throw new Error('PowerShell runtime probe failed.');
  const runtime = parseExactJson(execution.stdout);
  if (runtime.edition !== 'Desktop' || runtime.major !== 5 || runtime.minor !== 1 || runtime.x64 !== true) {
    throw new Error('Runtime is not x64 Windows Desktop PowerShell 5.1.');
  }
  return runtime;
}

export function sortedEnvironmentKeys(env) {
  // Object keys are strings: relational comparison preserves default UTF-16
  // code-unit ordering without locale-dependent collation.
  return Object.keys(env).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

export function suiteReceipt(suite, execution, { binary, args, cwd, powershellVersion }) {
  const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const record = { name: suite[0], executable: binary, args, cwd,
    startedAt: execution.startedAt, finishedAt: execution.finishedAt, elapsedMs: execution.elapsedMs,
    timeoutMs: execution.timeoutMs, maxBytes: execution.maxBytes,
    spawned: execution.spawned, spawnErrorCode: execution.spawnErrorCode, spawnedAfterMs: execution.spawnedAfterMs,
    firstOutputAfterMs: { ...execution.firstOutputAfterMs },
    stdout: digest(execution.stdoutBytes), stderr: digest(execution.stderrBytes),
    exitCode: execution.exitCode, signal: execution.signal, failure: execution.failure, passed: false };
  try { record.result = validateResult(suite, execution, powershellVersion); record.passed = true; }
  catch (error) { record.error = error.message; }
  return record;
}

export function validateResult(suite, execution, powershellVersion) {
  if (execution.failure || execution.exitCode !== 0 || execution.signal) throw new Error('Child did not complete successfully.');
  const result = parseExactJson(execution.stdout);
  const [name, schema, counter] = suite;
  if (result.schema !== schema || result.passed !== true || result.network !== false ||
      result.nativeActions !== 0 || !Number.isSafeInteger(result[counter]) || result[counter] <= 0) {
    throw new Error('Missing or invalid inert suite result.');
  }
  if (name === 'test-output-replay.ps1' && result.disk !== true) throw new Error('Windows disk replay branch was not exercised.');
  if (['test-state.ps1', 'test-task.ps1'].includes(name) && result.disk !== false) throw new Error('Unexpected disk qualification.');
  if (['test-state.ps1', 'test-boundaries.ps1'].includes(name) && result.windowsQualified !== false) throw new Error('Unexpected Windows qualification claim.');
  if (name === 'test-state.ps1' && result.dpapiQualified !== false) throw new Error('Unexpected DPAPI qualification claim.');
  if (name === 'test-boundaries.ps1' && result.credentialFiles !== false) throw new Error('Unexpected credential file access.');
  if (['test-task.ps1', 'test-output-replay.ps1'].includes(name) && result.powershell !== powershellVersion) throw new Error('Suite runtime differs from probe.');
  return result;
}

export function parseExactJson(text) {
  const normalized = text.replace(/^\uFEFF/, '').trim();
  const result = JSON.parse(normalized);
  // JSON.parse accepts duplicate keys. After grammar validation, scan keys in
  // each object (including escaped equivalents) and refuse ambiguity.
  const stack = [];
  for (const token of normalized.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? []) {
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)) stack.at(-1).key = true;
    else if (token === ':' && stack.at(-1)) stack.at(-1).key = false;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const key = JSON.parse(token);
      if (stack.at(-1).keys.has(key)) throw new Error('Duplicate JSON key.');
      stack.at(-1).keys.add(key);
    }
  }
  return result;
}

// Direct children only; no shell, PowerShell profile, execution-policy override,
// process discovery, workstation cleanup, or retries. CI owns the disposable VM.
export function runChild(binary, args, { cwd, env, timeoutMs = 60_000, maxBytes = 1_048_576 } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let finished = false;
    let killTimer;
    let spawned = false;
    let spawnErrorCode = null;
    let spawnedAfterMs = null;
    const firstOutputAfterMs = { stdout: null, stderr: null };
    function finish(exitCode, signal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const stdoutBytes = Buffer.concat(chunks.stdout);
      const stderrBytes = Buffer.concat(chunks.stderr);
      try { new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes); new TextDecoder('utf-8', { fatal: true }).decode(stderrBytes); }
      catch { failure ??= 'invalid_utf8'; }
      resolve({ exitCode, signal, failure, startedAt, finishedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started), timeoutMs, maxBytes, spawned, spawnErrorCode,
        spawnedAfterMs, firstOutputAfterMs,
        stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8'), stdoutBytes, stderrBytes });
    }
    function stop(reason) {
      if (failure) return;
      failure = reason;
      child.kill('SIGKILL');
      killTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(null, null);
      }, 2_000);
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (bytes) => {
        firstOutputAfterMs[stream] ??= Math.round(performance.now() - started);
        const remaining = Math.max(0, maxBytes - sizes[stream]);
        chunks[stream].push(bytes.subarray(0, remaining));
        sizes[stream] += bytes.length;
        if (sizes[stream] > maxBytes) stop('output_limit');
      });
    }
    child.on('spawn', () => { spawned = true; spawnedAfterMs = Math.round(performance.now() - started); });
    child.on('error', (error) => { failure ??= 'spawn_error'; spawnErrorCode = String(error.code ?? 'UNKNOWN').slice(0, 80); finish(null, null); });
    child.on('close', finish);
  });
}

async function main() {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = process.env.OVD_INERT_RESULTS;
  if (!output || !path.isAbsolute(output)) throw new Error('OVD_INERT_RESULTS must be an absolute disposable evidence directory.');
  mkdirSync(output, { recursive: false });
  const report = { schema: 'overdrafter.companion-inert-ci.v1', startedAt: new Date().toISOString(), node: process.version, platform: process.platform, suites: [], passed: false, qualification: 'inert-only' };
  const save = () => writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    const gitExecutable = resolveGitExecutable();
    report.git = { executable: gitExecutable, sha256: createHash('sha256').update(readFileSync(gitExecutable)).digest('hex') };
    const git = (...args) => execFileSync(gitExecutable, args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
    report.git.version = git('--version');
    report.expectedSha = process.env.OVD_EXPECTED_SHA;
    report.checkoutSha = git('rev-parse', 'HEAD');
    report.checkoutTree = git('rev-parse', 'HEAD^{tree}');
    report.trackedStatus = git('status', '--porcelain', '--untracked-files=no');
    if (!/^[a-f0-9]{40}$/.test(report.expectedSha ?? '') || report.expectedSha !== report.checkoutSha) throw new Error('Exact reviewed checkout SHA mismatch.');
    if (report.trackedStatus) throw new Error('Tracked checkout is dirty.');
    const files = git('ls-files', '-z', '--', 'scripts/native', 'scripts/native-companion-inert-ci.mjs', 'scripts/native-companion-inert-ci.node-test.mjs', '.github/workflows/companion-inert-qualified.yml').split('\0').filter(Boolean).sort();
    const hashFiles = () => files.map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(path.join(cwd, file))).digest('hex') }));
    report.sourceFiles = hashFiles();
    save();
    if (process.platform !== 'win32') throw new Error('Windows Desktop PowerShell 5.1 is required; no suite executed.');
    const binary = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
    report.powershellExecutable = binary;
    report.powershellExecutableSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
    report.probe = { timeoutMs: 10_000, args: runtimeProbeArgs, environmentKeys: sortedEnvironmentKeys(env),
      inheritedPSModulePathPresent: Object.keys(process.env).some((key) => key.toLowerCase() === 'psmodulepath') };
    save();
    const probe = await runChild(binary, runtimeProbeArgs, { cwd, env, timeoutMs: 10_000 });
    writeFileSync(path.join(output, 'runtime-probe.stdout.log'), probe.stdoutBytes);
    writeFileSync(path.join(output, 'runtime-probe.stderr.log'), probe.stderrBytes);
    writeFileSync(path.join(output, 'runtime-probe.json'), JSON.stringify({ ...probe, stdoutBytes: undefined, stderrBytes: undefined }, null, 2));
    report.probe.outcome = runtimeProbeDiagnostics(probe);
    report.powershell = validateRuntimeProbe(probe);
    for (const suite of suites) {
      const [name] = suite;
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(cwd, 'scripts/native/worker-companion', name)];
      const execution = await runChild(binary, args, { cwd, env });
      writeFileSync(path.join(output, name + '.stdout.log'), execution.stdoutBytes);
      writeFileSync(path.join(output, name + '.stderr.log'), execution.stderrBytes);
      const record = suiteReceipt(suite, execution, { binary, args, cwd, powershellVersion: report.powershell.version });
      report.suites.push(record); save();
    }
    if (git('rev-parse', 'HEAD') !== report.checkoutSha || JSON.stringify(hashFiles()) !== JSON.stringify(report.sourceFiles) || git('status', '--porcelain', '--untracked-files=no')) throw new Error('Source changed during qualification.');
    report.passed = report.suites.length === 4 && report.suites.every((suite) => suite.passed);
    if (!report.passed) throw new Error('One or more inert suites failed; inspect retained evidence.');
  } catch (error) {
    report.error = error.message;
    console.error(JSON.stringify({ qualification: 'inert-only', passed: false, error: String(error.message).slice(0, 2000), probe: report.probe?.outcome }));
    process.exitCode = 1;
  }
  finally { report.finishedAt = new Date().toISOString(); save(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
