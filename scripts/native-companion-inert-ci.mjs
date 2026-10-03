import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suites = Object.freeze([
  ['test-state.ps1', 'overdrafter.companion-state-test.v1', 'assertions'],
  ['test-boundaries.ps1', 'overdrafter.companion-boundary-test.v1', 'assertions'],
  ['test-task.ps1', 'overdrafter.companion-task-test.v1', 'assertions'],
  ['test-output-replay.ps1', 'overdrafter.companion-output-replay-test.v1', 'checks'],
]);

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
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let finished = false;
    let killTimer;
    function finish(exitCode, signal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const stdoutBytes = Buffer.concat(chunks.stdout);
      const stderrBytes = Buffer.concat(chunks.stderr);
      try { new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes); new TextDecoder('utf-8', { fatal: true }).decode(stderrBytes); }
      catch { failure ??= 'invalid_utf8'; }
      resolve({ exitCode, signal, failure, stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8'), stdoutBytes, stderrBytes });
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
        const remaining = Math.max(0, maxBytes - sizes[stream]);
        chunks[stream].push(bytes.subarray(0, remaining));
        sizes[stream] += bytes.length;
        if (sizes[stream] > maxBytes) stop('output_limit');
      });
    }
    child.on('error', () => { failure = 'spawn_error'; finish(null, null); });
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
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
  try {
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
    const probe = await runChild(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @{edition=$PSVersionTable.PSEdition;version=$PSVersionTable.PSVersion.ToString();major=$PSVersionTable.PSVersion.Major;minor=$PSVersionTable.PSVersion.Minor;x64=[Environment]::Is64BitProcess} | ConvertTo-Json -Compress"], { cwd, env, timeoutMs: 10_000 });
    writeFileSync(path.join(output, 'runtime-probe.stdout.log'), probe.stdoutBytes);
    writeFileSync(path.join(output, 'runtime-probe.stderr.log'), probe.stderrBytes);
    writeFileSync(path.join(output, 'runtime-probe.json'), JSON.stringify({ ...probe, stdoutBytes: undefined, stderrBytes: undefined }, null, 2));
    if (probe.failure || probe.exitCode !== 0) throw new Error('PowerShell runtime probe failed.');
    report.powershell = parseExactJson(probe.stdout);
    if (report.powershell.edition !== 'Desktop' || report.powershell.major !== 5 || report.powershell.minor !== 1 || report.powershell.x64 !== true) throw new Error('Runtime is not x64 Windows Desktop PowerShell 5.1.');
    for (const suite of suites) {
      const [name] = suite;
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(cwd, 'scripts/native/worker-companion', name)];
      const startedAt = new Date().toISOString();
      const execution = await runChild(binary, args, { cwd, env });
      writeFileSync(path.join(output, name + '.stdout.log'), execution.stdoutBytes);
      writeFileSync(path.join(output, name + '.stderr.log'), execution.stderrBytes);
      const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      const record = { name, executable: binary, args, cwd, startedAt, finishedAt: new Date().toISOString(),
        stdout: digest(execution.stdoutBytes), stderr: digest(execution.stderrBytes),
        exitCode: execution.exitCode, signal: execution.signal, failure: execution.failure, passed: false };
      try { record.result = validateResult(suite, execution, report.powershell.version); record.passed = true; }
      catch (error) { record.error = error.message; }
      report.suites.push(record); save();
    }
    if (git('rev-parse', 'HEAD') !== report.checkoutSha || JSON.stringify(hashFiles()) !== JSON.stringify(report.sourceFiles) || git('status', '--porcelain', '--untracked-files=no')) throw new Error('Source changed during qualification.');
    report.passed = report.suites.length === 4 && report.suites.every((suite) => suite.passed);
    if (!report.passed) throw new Error('One or more inert suites failed; inspect retained evidence.');
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally { report.finishedAt = new Date().toISOString(); save(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
