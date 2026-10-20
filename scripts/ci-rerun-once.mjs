import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isEntryPoint, resolveGhBin } from './emit-verdict.mjs';

/*
 * `gh run view --log-failed` prints every line as `<job>\t<step>\t<timestamp> <text>`, and
 * the timestamp carries seven fractional digits ("...T04:43:55.2429429Z"), so an unanchored
 * /429/ matches timestamps. Passing test names ("...403, 429 and 503", "...a rate limit...")
 * also reach the failed log. Strip the prefix first, then accept a signal only where an
 * infrastructure failure actually reports itself.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, 'g');
const LOG_PREFIX = /^(?:[^\t]*\t[^\t]*\t)?\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// Runner annotations: the runner was lost or told to stop. These carry no test output.
const RUNNER_SIGNAL = /^(?:##\[(?:error|warning)\])?\s*the (?:(?:hosted|self-hosted) )?runner\b.*\b(?:lost communication with the server|received a shutdown signal)/i;
// Throttling and truncated transfers count only on a line that reports an error (a GitHub
// ##[error] annotation or a failing tool's own error line), never on test names or output.
const ERROR_LINE = /^(?:##\[error\]|npm (?:error|ERR!)|\w*error\b|fatal\b|curl\b)/i;
const THROTTLE_SIGNAL = new RegExp([
  String.raw`\b429 \(?too many requests\b`,
  String.raw`\b(?:http(?:\/[\d.]+)?|status(?: code)?|error:?|code) E?429\b`,
  String.raw`\b(?:api |secondary )?rate limit exceeded\b`,
  String.raw`\bexceeded a secondary rate limit\b`,
  String.raw`\btoomanyrequests:`,
  String.raw`\brate-limited after \d+ attempts\b`,
  String.raw`\bunexpected EOF\b`,
].join('|'), 'i');
// A stage that ran and failed, or a rejected PR body, is a code failure that a rerun cannot fix.
// It wins over any infrastructure signal in the same log.
const CODE_FAILURE = /^(?:preflight: \S+ FAIL\b|PR body validation failed\b|(?:##\[error\])?PR body validator exited \w+ without validation evidence)/;

const normalizeLogLine = line => line.replace(ANSI, '').replace(LOG_PREFIX, '').trimEnd();

/** Classify one run's `--log-failed` output as an infrastructure failure. */
export function isInfraFailure(text) {
  const lines = String(text).split(/\r?\n/).map(normalizeLogLine);
  if (lines.some(line => CODE_FAILURE.test(line))) return false;
  return lines.some(line => RUNNER_SIGNAL.test(line) || (ERROR_LINE.test(line) && THROTTLE_SIGNAL.test(line)));
}

/** Decide using GitHub's attempt counters, before requesting any mutations. */
export function decideRerun(sha, head, runs, logs) {
  if (sha !== head) return 'not-head';
  if (runs.some(run => run.attempt >= 2)) return 'cap-reached';
  const failed = runs.filter(isFailed);
  if (!failed.length || failed.some(run => !isInfraFailure(logs[run.databaseId] ?? ''))) return 'not-infra';
  return null;
}
const isFailed = run => ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion);

/** Parse only the documented CLI options. */
export function parseArgs(args) {
  const options = { repo: 'optomachina/Overdrafter', caller: 'unknown', log: '/workspace/ci-rerun-once.jsonl' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !['pr', 'sha', 'repo', 'caller', 'log'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage');
    options[key] = args[i + 1];
  }
  if (!/^[1-9]\d*$/.test(options.pr) || !/^[a-f0-9]{40}$/i.test(options.sha) || !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('usage');
  return options;
}

function collectRuns(gh, sha) {
  return JSON.parse(gh('run', 'list', '--commit', sha, '--limit', '1000', '--json', 'databaseId,attempt,conclusion,status,name,url'));
}

function decide(gh, sha, head, runs) {
  // Fail closed if the result may have been truncated or lacks attempt evidence.
  if (runs.length >= 1000 || runs.some(run => !Number.isInteger(run.attempt) || run.attempt < 1)) throw new Error('incomplete runs');
  if (runs.some(run => run.attempt >= 2)) return 'cap-reached';
  const logs = {};
  for (const run of runs.filter(isFailed)) logs[run.databaseId] = gh('run', 'view', String(run.databaseId), '--log-failed');
  return decideRerun(sha, head, runs, logs);
}

function performReruns(gh, runs) {
  for (const run of runs.filter(isFailed)) gh('run', 'rerun', String(run.databaseId), '--failed');
}

export function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch { console.error('Usage: node scripts/ci-rerun-once.mjs --pr <n> --sha <sha> [--repo owner/repo] [--caller name] [--log path]'); return 2; }
  const { sha, pr, repo, caller, log } = options;
  let runs = [], reason, decision = 'refused';
  try {
    const ghBin = resolveGhBin();
    const gh = (...args) => execFileSync(ghBin, [...args, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const head = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefOid')).headRefOid;
    reason = sha === head ? null : 'not-head';
    if (!reason) {
      runs = collectRuns(gh, sha);
      reason = decide(gh, sha, head, runs);
    }
    if (!reason) {
      performReruns(gh, runs);
      decision = 'rerun';
    }
  } catch { reason = 'gh-error'; }
  try { appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), sha, pr, runs: runs.map(run => run.databaseId), caller, decision, reason })}\n`); }
  catch { console.error('rerun-cap: logging unavailable'); }
  console.log(decision === 'rerun' ? `rerun-cap: rerun ${runs.filter(isFailed).map(run => run.databaseId).join(',')}` : `rerun-cap: refused (${reason})`);
  return decision === 'rerun' ? 0 : 3;
}

// isEntryPoint() defaults its module URL to emit-verdict.mjs, so name this module explicitly.
if (isEntryPoint(import.meta.url)) process.exitCode = main();
