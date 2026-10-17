import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Match the watcher's description and failed-log infrastructure signals. */
export function isInfraFailure(text) {
  return /429|rate limit|runner.*(?:lost|shutdown)|lost communication|unexpected EOF/i.test(text);
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

export function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch { console.error('Usage: node scripts/ci-rerun-once.mjs --pr <n> --sha <sha> [--repo owner/repo] [--caller name] [--log path]'); return 2; }
  const { sha, pr, repo, caller, log } = options;
  const gh = (...args) => execFileSync('gh', [...args, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let runs = [], reason, decision = 'refused';
  try {
    const head = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefOid')).headRefOid;
    reason = sha === head ? null : 'not-head';
    if (!reason) {
      runs = JSON.parse(gh('run', 'list', '--commit', sha, '--limit', '1000', '--json', 'databaseId,attempt,conclusion,status,name,url'));
      // Fail closed if the result may have been truncated or lacks attempt evidence.
      if (runs.length >= 1000 || runs.some(run => !Number.isInteger(run.attempt) || run.attempt < 1)) throw new Error('incomplete runs');
      reason = runs.some(run => run.attempt >= 2) ? 'cap-reached' : null;
      if (!reason) {
        const logs = {};
        for (const run of runs.filter(isFailed)) logs[run.databaseId] = gh('run', 'view', String(run.databaseId), '--log-failed');
        reason = decideRerun(sha, head, runs, logs);
      }
    }
    if (!reason) {
      for (const run of runs.filter(isFailed)) gh('run', 'rerun', String(run.databaseId), '--failed');
      decision = 'rerun';
    }
  } catch { reason = 'gh-error'; }
  try { appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), sha, pr, runs: runs.map(run => run.databaseId), caller, decision, reason })}\n`); }
  catch { console.error('rerun-cap: logging unavailable'); }
  console.log(decision === 'rerun' ? `rerun-cap: rerun ${runs.filter(isFailed).map(run => run.databaseId).join(',')}` : `rerun-cap: refused (${reason})`);
  return decision === 'rerun' ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
