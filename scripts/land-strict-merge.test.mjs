// @vitest-environment node
// OVD-889: runs the real .codex/skills/land/land_strict_merge.sh against a stub
// gh and real git repos (a bare origin plus a clone, built once and copied per
// test). The temp path contains a space, so an unquoted expansion in the script
// breaks these tests. The script runs through async spawn so a slow run never
// blocks the vitest worker.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

// Real git plus bash per test; allow for slow CI runners.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const script = fileURLToPath(new URL('../.codex/skills/land/land_strict_merge.sh', import.meta.url));
// The script must set these itself; never inherit them from the test runner.
delete process.env.GIT_HTTP_LOW_SPEED_LIMIT; delete process.env.GIT_HTTP_LOW_SPEED_TIME;
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
let template, root, cwd, B, H, M, U, R, X, W, S;
function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
}
function commit(file, content) {
  writeFileSync(join(cwd, file), content);
  git('add', '--', file); git('commit', '-qm', content);
  return git('rev-parse', 'HEAD');
}
// Commits: B base on main; H the PR head (child of B); M main moved on (child
// of B), so H is behind; U the update merge of M into H (first parent H); R a
// rebase-like replay of H on M (one parent); X an unrelated push on H (one
// parent); W a two-parent merge of M whose first parent is X, not H.
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'land strict-tpl-')); cwd = template;
  git('init', '--bare', 'origin.git');
  git('--git-dir=origin.git', 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git('clone', 'origin.git', 'work'); cwd = join(template, 'work');
  // Relative so the copied clone fetches from its own copied origin.
  git('remote', 'set-url', 'origin', '../origin.git');
  B = commit('base', 'base'); git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'pr'); H = commit('feature', 'feature');
  git('checkout', '-q', 'main'); M = commit('main', 'main'); git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'pr'); git('merge', '-q', '--no-ff', '-m', 'update', M); U = git('rev-parse', 'HEAD');
  S = git('commit-tree', `${U}^{tree}`, '-p', M, '-m', 'squash');
  git('push', '-q', 'origin', `${S}:refs/heads/squash`);
  git('branch', 'update', U); git('checkout', '-qb', 'replayed', M); R = commit('feature', 'feature');
  git('checkout', '-qb', 'other', H); X = commit('other', 'other');
  git('checkout', '-qb', 'wrongparent', X); git('merge', '-q', '--no-ff', '-m', 'wrong parent', M); W = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'pr', 'update', 'replayed', 'other', 'wrongparent');
  git('checkout', '-q', 'main');
  writeFileSync(join(template, 'gh'), `#!/usr/bin/env node
// Stub gh: logs argv, answers from LAND_STUB_SCENARIO by call kind, consuming
// responses in order and repeating the last one. Unknown calls exit 99.
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LAND_STUB_LOG, JSON.stringify(args)+'\\n');
const scenario = JSON.parse(fs.readFileSync(process.env.LAND_STUB_SCENARIO));
let kind = args[0]==='pr' && args[1]==='view' ? 'pr-view' : args[0]==='pr' && args[1]==='merge' ? 'merge' : args.includes('PUT') ? 'update-branch' : args.join(' ').includes('/protection/required_status_checks') ? 'protection' : args.join(' ').includes('/status?') ? 'statuses' : args.join(' ').includes('check_name=') ? 'check-runs:'+args.join(' ').match(/check_name=([^&]+)/)[1] : 'unknown';
const path = process.env.LAND_STUB_LOG+'.counts';
const counts = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : {};
const responses = scenario[kind];
if (!responses) process.exit(99);
const r = responses[Math.min(counts[kind] || 0, responses.length-1)];
counts[kind]=(counts[kind]||0)+1; fs.writeFileSync(path,JSON.stringify(counts));
if (r.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleep * 1000);
process.stdout.write(typeof r.stdout==='object'?JSON.stringify(r.stdout):r.stdout||'');
process.stderr.write(r.stderr||''); process.exit(r.code||0);
`, { mode: 0o755 });
});
afterAll(() => rmSync(template, { recursive: true, force: true }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'land strict-'));
  cpSync(template, root, { recursive: true });
  cwd = join(root, 'work');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const response = stdout => ({ stdout });
const statuses = (items, sha = U, total_count = items.length) => response({ sha, total_count, statuses: items });
const pr = (head = U, mergeStateStatus = 'CLEAN', state = 'OPEN') => response({ state, isDraft: false, mergeStateStatus, headRefOid: head, baseRefName: 'main', mergeCommit: { oid: S } });
const runs = (name, head = U, status = 'completed', conclusion = 'success', app = 15368) => response({ total_count: 1, check_runs: [{ name, head_sha: head, status, conclusion, app: { id: app } }] });
function scenario(views = [pr(), pr(), pr(), pr(U, 'CLEAN', 'MERGED')]) {
  return { protection: [response({ checks: [{ context: 'ci', app_id: 15368 }, { context: 'provider-go-live', app_id: 15368 }] })], statuses: [statuses([])], 'pr-view': views, 'check-runs:ci': [runs('ci')], 'check-runs:provider-go-live': [runs('provider-go-live')], merge: [response('')], 'update-branch': [response('')] };
}
function runScript(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], { cwd, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
// The reviewed head the script is given by default: the head the scenario's
// first PR read shows, so the PR head at pin time is the reviewed head. A
// malformed first head falls back to U, so those cases still reach the PR read.
function reviewedHead(s) {
  const first = s['pr-view']?.[0]?.stdout?.headRefOid;
  return /^[0-9a-f]{40}$/.test(first ?? '') ? first : U;
}
async function run(s, code, message, args = ['7', reviewedHead(s)], env = {}) {
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(s));
  // A fresh call log per run, so one test can run the script twice.
  rmSync(join(root, 'log'), { force: true }); rmSync(join(root, 'log.counts'), { force: true });
  const r = await runScript(args, { ...process.env, LAND_GH: join(root, 'gh'), LAND_STUB_SCENARIO: join(root, 'scenario.json'), LAND_STUB_LOG: join(root, 'log'), LAND_SLEEP: 'true', LAND_POLL_INTERVAL: '0', LAND_HEAD_POLLS: '2', LAND_CHECK_POLLS: '2', LAND_MERGEABLE_POLLS: '2', LAND_MERGE_POLLS: '2', ...env });
  expect(r.status, r.stderr).toBe(code); expect(r.stderr + r.stdout).toContain(message);
  const calls = existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  expect(calls.every(a => ['pr', 'api'].includes(a[0]))).toBe(true);
  if (code !== 0 && code !== 9 && code !== 8 && !message.includes('differs from the verified head') && !message.includes('merge refused') && !message.includes('merge not verified')) expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
  Object.defineProperty(calls, 'output', { value: r.stderr + r.stdout });
  return calls;
}
function expectMerge(calls, pin) {
  expect(calls.filter(a => a[1] === 'merge')).toEqual([['pr', 'merge', '7', '--squash', '--match-head-commit', pin]]);
}
// Same pinned raw diff as review_diff_id / computeDiffId.
function reviewDiffId(base, head) {
  const raw = spawnSync(realGit, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--full-index', '--no-relative', '--ignore-submodules=none', '-O/dev/null', '--no-color', '--end-of-options', `${base}...${head}`, '--'], { cwd });
  if (raw.status !== 0) throw Error(raw.stderr?.toString() || 'diff failed');
  return createHash('sha256').update(raw.stdout).digest('hex');
}
it('merges an up to date head pinned exactly', async () => {
  const calls = await run(scenario(), 0, 'merged and verified'); expectMerge(calls, U);
  expect(calls.some(a => a.includes('PUT'))).toBe(false);
  expect(calls.output).toContain('update chain: none');
});
it('updates behind main, ignores stale checks, waits for the merge head', async () => {
  const s = scenario([pr(H, 'BEHIND'), pr(H), pr(U), pr(U), pr(U), pr(U, 'CLEAN', 'MERGED')]);
  s['check-runs:ci'][0].stdout.check_runs.push(runs('ci', H, 'completed', 'failure').stdout.check_runs[0]);
  const calls = await run(s, 0, 'new pinned head'); expectMerge(calls, U);
  expect(reviewDiffId(B, H)).toBe(reviewDiffId(M, U));
  expect(calls.filter(a => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/7/update-branch', '-f', `expected_head_sha=${H}`]]);
  expect(calls.output).toContain(`update round 1/3: old head ${H} -> new head ${U} (origin/main ${M}, second parent ${M}); diff unchanged`);
  expect(calls.filter(a => a[0] === 'api' && !a.includes('PUT') && !a[1].includes('/protection/')).every(a => a[1].includes(`/commits/${U}/`))).toBe(true);
});
// A PR head H2 whose clean update merge U2 changes the reviewable diff: both
// sides edit `base` in different regions, so the merge is clean and the blob
// pair in the reviewable diff still changes. origin/main becomes M2.
function diffChangingUpdate() {
  git('checkout', '-q', '-b', 'fork', B);
  const fork = commit('base', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n');
  git('checkout', '-q', '-b', 'pr-diff');
  const H2 = commit('base', 'line1\nline2\nline3\nPR\nline4\nline5\nline6\nline7\n');
  git('checkout', '-q', '-b', 'main-diff', fork);
  const M2 = commit('base', 'MAIN\nline1\nline2\nline3\nline4\nline5\nline6\nline7\n');
  git('checkout', '-q', 'pr-diff');
  git('merge', '-q', '--no-ff', '-m', 'update', 'main-diff');
  const U2 = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'pr-diff');
  git('push', '-q', '--force', 'origin', 'main-diff:main');
  git('push', '-q', 'origin', `${U2}:refs/heads/update-diff`);
  return { fork, H2, M2, U2 };
}
it('stops without merging when the update changes the diff', async () => {
  const { fork, H2, M2, U2 } = diffChangingUpdate();
  const oldDiff = reviewDiffId(fork, H2);
  const newDiff = reviewDiffId(M2, U2);
  expect(oldDiff).not.toBe(newDiff);
  const calls = await run(scenario([pr(H2, 'BEHIND'), pr(U2)]), 11, `a fresh review and QA verdict at ${U2} are required before landing`);
  expect(calls.output).toContain(`land: STOP: updated ${H2} -> ${U2} and the PR diff changed (diff_id ${oldDiff} -> ${newDiff}); a fresh review and QA verdict at ${U2} are required before landing`);
  expect(calls.output).not.toContain('re-run land when checks pass');
  expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
  expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
  expect(calls.filter(a => String(a[1]).includes('check_name='))).toEqual([]);
});
// PR #840 review r1, finding 1: run 1 sends update-branch and times out before
// the new head appears (exit 4, routed to "re-run from step 8"). Run 2 starts
// after GitHub applied the update, so the head already contains main. Without
// the reviewed head as input it pinned that head afresh and merged a changed
// diff that no one reviewed.
it('re-run after an unverified update re-checks the diff and does not merge a changed one', async () => {
  const { fork, H2, M2, U2 } = diffChangingUpdate();
  const first = await run(scenario([pr(H2, 'BEHIND'), pr(H2), pr(H2)]), 4, 'timed out waiting for the updated head', ['7', H2]);
  expect(first.filter(a => a.includes('PUT'))).toHaveLength(1);
  expect(first.output).toContain(`update-branch was sent from ${H2} and not verified; re-run with the reviewed head ${H2}`);
  const second = await run(scenario([pr(U2), pr(U2), pr(U2), pr(U2, 'CLEAN', 'MERGED')]), 11, `a fresh review and QA verdict at ${U2} are required before landing`, ['7', H2]);
  expect(second.output).toContain(`land: STOP: PR head ${U2} is an update of the reviewed head ${H2} and the PR diff changed (diff_id ${reviewDiffId(fork, H2)} -> ${reviewDiffId(M2, U2)})`);
  expect(second.filter(a => a[1] === 'merge')).toEqual([]);
  expect(second.filter(a => a.includes('PUT') || String(a[1]).includes('check_name='))).toEqual([]);
});
it('re-run pins an earlier diff-unchanged update of the reviewed head and reports it', async () => {
  const calls = await run(scenario([pr(U), pr(U), pr(U), pr(U, 'CLEAN', 'MERGED')]), 0, `update chain: ${H} -> ${U} (updated before this run; main ${M})`, ['7', H]);
  expectMerge(calls, U);
  expect(calls.some(a => a.includes('PUT'))).toBe(false);
  expect(calls.output).toContain(`PR head ${U} is the reviewed head ${H} brought up to date before this run; diff unchanged`);
});
it('accepts a chain of update merges since the reviewed head', async () => {
  // main moves again after U, and U3 merges that into U: two update merges.
  git('checkout', '-q', 'main'); const M3 = commit('main2', 'main2'); git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'update'); git('merge', '-q', '--no-ff', '-m', 'update again', M3); const U3 = git('rev-parse', 'HEAD');
  const S3 = git('commit-tree', `${U3}^{tree}`, '-p', M3, '-m', 'squash3');
  git('push', '-q', 'origin', 'update', `${S3}:refs/heads/squash3`);
  const merged = pr(U3, 'CLEAN', 'MERGED'); merged.stdout.mergeCommit = { oid: S3 };
  const s = scenario([pr(U3), pr(U3), pr(U3), merged]);
  s['check-runs:ci'] = [runs('ci', U3)]; s['check-runs:provider-go-live'] = [runs('provider-go-live', U3)];
  const calls = await run(s, 0, `update chain: ${H} -> ${U3} (updated before this run; main ${M3})`, ['7', H]);
  expectMerge(calls, U3);
});
it.each(['push', 'rebase', 'wrong parent', 'reviewed elsewhere'])('refuses a head that is not a proven update of the reviewed head: %s', async kind => {
  const [head, reviewed] = { push: [X, H], rebase: [R, H], 'wrong parent': [W, H], 'reviewed elsewhere': [U, X] }[kind];
  const calls = await run(scenario([pr(head)]), 5, 'unexpected history', ['7', reviewed]);
  expect(calls.filter(a => a[1] !== 'view')).toEqual([]);
});
it('does not merge when the pre-update diff cannot be read', async () => {
  writeFileSync(join(root, 'git'), `#!/bin/bash
if [ "$1" = diff ]; then exit 1; fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  const calls = await run(scenario([pr(H, 'BEHIND'), pr(U)]), 5, 'could not read the pre-update diff', undefined, { PATH: `${root}:${process.env.PATH}` });
  expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
  expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
});
it('does not merge when the post-update diff cannot be read', async () => {
  writeFileSync(join(root, 'git'), `#!/bin/bash
if [ "$1" = diff ]; then
  for arg in "$@"; do
    if [ "$arg" = '${M}...${U}' ]; then exit 1; fi
  done
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  const calls = await run(scenario([pr(H, 'BEHIND'), pr(U)]), 5, 'could not read the post-update diff; not merging', undefined, { PATH: `${root}:${process.env.PATH}` });
  expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
  expect(calls.filter(a => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/7/update-branch', '-f', `expected_head_sha=${H}`]]);
  expect(calls.output).not.toContain('diff unchanged');
  expect(calls.output).not.toContain('new pinned head');
});
it('rejects head movement during checks at the first poll', async () => {
  const s = scenario([pr(), pr(X)]);
  s['check-runs:ci'] = [runs('ci', U, 'in_progress', ''), runs('ci')];
  const calls = await run(s, 5, 'head changed');
  expect(calls.filter(a => a[1]?.includes('check_name=ci&'))).toHaveLength(1);
});
it.each(['rebase', 'push'])('rejects unexpected update history: %s', async kind => {
  await run(scenario([pr(H, 'BEHIND'), pr(kind === 'rebase' ? R : X)]), 5, 'unexpected history');
});
it.each(['failure', 'cancelled'])('rejects completed %s', async conclusion => {
  const s = scenario(); s['check-runs:ci'] = [runs('ci', U, 'completed', conclusion)]; await run(s, 3, 'FAILED');
});
it('times out after exactly the configured check polls', async () => {
  const s = scenario([pr()]); s['check-runs:ci'] = [runs('ci', U, 'in_progress', '')];
  const calls = await run(s, 4, 'timed out waiting for required checks');
  expect(calls.filter(a => a[1]?.includes('check_name=ci&'))).toHaveLength(2);
});
it('waits for checks to register', async () => {
  const s = scenario([pr(), pr(), pr(), pr(), pr(U, 'CLEAN', 'MERGED')]);
  s['check-runs:ci'].unshift(response({ total_count: 0, check_runs: [] })); expectMerge(await run(s, 0, 'merged and verified'), U);
});
it.each(['short', 'long', 'upper', 'newline', 'injection', 'empty', 'nul'])('rejects malformed SHA: %s', async kind => {
  // nul: bash drops NUL bytes, so "\u0000<40 hex>" must not become a valid SHA.
  const bad = { short: H.slice(1), long: H+'a', upper: 'A'.repeat(40), newline: H+'\n', injection: H+'\n$(touch pwned)', empty: '', nul: '\u0000'+H }[kind];
  await run(scenario([pr(bad)]), 5, 'malformed SHA'); expect(existsSync(join(cwd, 'pwned'))).toBe(false);
});
it('rejects merged head mismatch', async () => await run(scenario([pr(), pr(), pr(), pr(X, 'CLEAN', 'MERGED')]), 5, 'differs from the verified head'));
it.each([true, false])('verifies even after failed merge: merged=%s', async merged => {
  const s = scenario([pr(), pr(), pr(), pr(U, 'CLEAN', merged ? 'MERGED' : 'OPEN')]); s.merge = [{ code: 1, stderr: 'refused' }];
  expectMerge(await run(s, merged ? 0 : 5, merged ? 'merged and verified' : 'merge refused'), U);
});
it('rejects DIRTY', async () => await run(scenario([pr(U, 'DIRTY')]), 6, 'merge conflict'));
it('routes update conflicts', async () => {
  const s = scenario([pr(H, 'BEHIND')]); s['update-branch'] = [{ code: 1, stderr: '422 Merge Conflict' }];
  const calls = await run(s, 6, 'merge conflict'); expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
});
it('caps update rounds when the base keeps moving', async () => {
  // origin/main moves past M after the update, so U is genuinely behind again.
  git('checkout', '-q', 'main'); commit('main2', 'main2'); git('push', '-q', 'origin', 'main');
  const s = scenario([pr(H, 'BEHIND'), pr(U), pr(U), pr(U, 'BEHIND')]);
  const calls = await run(s, 7, 'update rounds used', undefined, { LAND_MAX_UPDATES: '1' }); expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
  expect(calls.output).toContain('update round 1/1:');
});
it('fails closed on unreadable PR', async () => await run(scenario([{ code: 1 }]), 5, 'PR unreadable'));
it.each([[], ['7'], ['abc', 'U'], ['07', 'U'], ['1;rm', 'U'], ['7', 'short'], ['7', 'upper'], ['7', 'newline'], ['7', 'U', 'extra']])('rejects usage %j without gh', async (...row) => {
  // Vitest spreads array rows; an empty row may arrive as one empty array.
  // Placeholders become SHAs here because the commits exist only after beforeAll.
  const sub = { U, short: U.slice(1), upper: U.toUpperCase(), newline: U + '\n' };
  const argv = (Array.isArray(row[0]) ? row[0] : row).map(a => sub[a] ?? a);
  expect(await run({}, 2, 'STOP', argv)).toEqual([]);
});
it('ignores checks from another app', async () => {
  const s = scenario([pr()]); s['check-runs:ci'] = [runs('ci', U, 'completed', 'success', 1)]; await run(s, 4, 'timed out waiting for required checks');
});
it.each(['neutral', 'skipped', 'timed_out', 'action_required', 'stale', null, ''])('fails closed on completed conclusion %s', async conclusion => {
  const s = scenario(); s['check-runs:ci'] = [runs('ci', U, 'completed', conclusion)]; await run(s, 3, 'FAILED');
});
it('times out when the update does not publish a new head', async () => {
  const calls = await run(scenario([pr(H, 'BEHIND')]), 4, 'timed out waiting for the updated head');
  expect(calls.filter(a => a[1] === 'view')).toHaveLength(3);
});
it('waits for lazily computed mergeability', async () => {
  const s = scenario([pr(), pr(), pr(U, 'UNKNOWN'), pr(), pr(U, 'CLEAN', 'MERGED')]);
  expectMerge(await run(s, 0, 'merged and verified'), U);
});
it('does not report success without a valid merge commit', async () => {
  const merged = pr(U, 'CLEAN', 'MERGED'); merged.stdout.mergeCommit = null;
  const calls = await run(scenario([pr(), pr(), pr(), merged]), 5, 'merge not verified');
  expectMerge(calls, U);
});
it('treats unreadable check responses as unverified polls', async () => {
  const s = scenario([pr()]); s['check-runs:ci'] = [response('not JSON')];
  await run(s, 4, 'timed out waiting for required checks');
});
it.each(['-1', 'abc', '1.5'])('rejects invalid poll count %s', async count => {
  expect(await run({}, 2, 'invalid numeric configuration', undefined, { LAND_CHECK_POLLS: count })).toEqual([]);
});
it('does not re-update when BEHIND is stale and the head already contains the base', async () => {
  const s = scenario([pr(H, 'BEHIND'), pr(U), pr(U), pr(U, 'BEHIND'), pr(U, 'CLEAN'), pr(U, 'CLEAN', 'MERGED')]);
  const calls = await run(s, 0, 'merged and verified');
  expectMerge(calls, U);
  expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
});
it('stops when update-branch reports the head moved since it was pinned', async () => {
  const s = scenario([pr(H, 'BEHIND')]);
  s['update-branch'] = [{ code: 1, stderr: "gh: expected head sha didn't match current head ref. (HTTP 422)" }];
  await run(s, 5, 'head moved since it was pinned');
});
it('stops on a closed PR while waiting for the updated head', async () => {
  await run(scenario([pr(H, 'BEHIND'), pr(H, 'BEHIND', 'CLOSED')]), 5, 'PR is CLOSED during the update');
});
it('rejects a draft PR before calling anything mutating', async () => {
  const draft = pr(); draft.stdout.isDraft = true;
  const calls = await run(scenario([draft]), 2, 'PR is draft');
  expect(calls.filter(a => a[1] !== 'view')).toEqual([]);
});
it('rejects a PR whose base is not main', async () => {
  const other = pr(); other.stdout.baseRefName = 'release';
  const calls = await run(scenario([other]), 2, "expected 'main'");
  expect(calls.filter(a => a[1] !== 'view')).toEqual([]);
});
it('rejects an unknown merge state', async () => await run(scenario([pr(U, 'SOMETHING_NEW')]), 5, 'unknown merge state'));
it('rejects an update merge whose first parent is not the pinned head', async () => {
  await run(scenario([pr(H, 'BEHIND'), pr(W)]), 5, 'not the pinned');
});
it('rejects a merge commit SHA hidden behind a NUL byte', async () => {
  const merged = pr(U, 'CLEAN', 'MERGED'); merged.stdout.mergeCommit = { oid: '\u0000' + M };
  expectMerge(await run(scenario([pr(), pr(), pr(), merged]), 5, 'merge not verified'), U);
});
it('queries check runs bound to the pinned SHA, by name, latest only', async () => {
  const calls = await run(scenario(), 0, 'merged and verified');
  const api = calls.filter(a => a[0] === 'api');
  expect(api).toEqual([
    ['api', 'repos/{owner}/{repo}/branches/main/protection/required_status_checks'],
    ['api', `repos/{owner}/{repo}/commits/${U}/check-runs?check_name=ci&filter=latest&per_page=100`],
    ['api', `repos/{owner}/{repo}/commits/${U}/check-runs?check_name=provider-go-live&filter=latest&per_page=100`],
  ]);
});
it('rejects a head change in the pre-merge re-read', async () => {
  // pin, check-poll read, then the pre-merge read shows another head.
  await run(scenario([pr(), pr(), pr(X)]), 5, 'head changed');
});

it.each(['0', 'abc'])('rejects invalid overall deadline %s', async value => {
  await run({}, 2, 'invalid numeric configuration', undefined, { LAND_DEADLINE: value });
});
it('enforces the overall deadline across pending polls', async () => {
  const s = scenario([pr()]); s['check-runs:ci'] = [runs('ci', U, 'in_progress')];
  const start = Date.now();
  const calls = await run(s, 8, 'deadline', undefined, { LAND_SLEEP: 'sleep', LAND_POLL_INTERVAL: '1', LAND_CHECK_POLLS: '1000', LAND_DEADLINE: '2' });
  expect(Date.now() - start).toBeLessThan(10000);
  expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
});
it('bounds a hung gh without coreutils timeout', async () => {
  expect(readFileSync(script, 'utf8')).not.toMatch(/\btimeout\s+["$]/);
  const s = scenario([{ sleep: 30, ...pr() }]); const start = Date.now();
  await run(s, 8, 'deadline', undefined, { LAND_DEADLINE: '2' });
  expect(Date.now() - start).toBeLessThan(10000);
});
it('bounds hung git fetch and exports low speed limits', async () => {
  writeFileSync(join(root, 'git'), `#!/bin/bash
if [ "$1" = fetch ]; then
  printf '%s/%s' "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" > "${root}/fetch-env"
  sleep 30
else
  exec '${realGit}' "$@"
fi
`, { mode: 0o755 });
  const start = Date.now();
  // The low-speed limits must come from the script, not from the caller
  // (they are deleted from this worker's environment at the top of the file).
  await run(scenario(), 8, 'deadline', undefined, { LAND_DEADLINE: '2', PATH: root + ':' + process.env.PATH });
  expect(Date.now() - start).toBeLessThan(10000);
  expect(readFileSync(join(root, 'fetch-env'), 'utf8')).toBe('1000/30');
});
it('warns if deadline expires after sending merge', async () => {
  const s = scenario(); s.merge = [{ sleep: 30 }];
  await run(s, 8, 'merge command was sent', undefined, { LAND_DEADLINE: '3' });
});
it('enforces extra protection checks and ignores configured overrides', async () => {
  const s = scenario([pr()]); s.protection[0].stdout.checks.push({ context: 'lint', app_id: 15368 });
  s['check-runs:lint'] = [response({ check_runs: [] })];
  const calls = await run(s, 4, 'timed out', undefined, { LAND_REQUIRED_CHECKS: 'ci' });
  expect(calls.some(a => a[1]?.includes('check_name=lint&'))).toBe(true);
});
it.each([{ code: 1 }, response({}), response({ checks: [] }), response([]), response({ checks: [{ context: '-bad', app_id: 15368 }] }), response({ checks: [{ context: 'ci\n', app_id: 15368 }] }), response({ checks: [{ context: 'ci', app_id: 0 }] })])('fails closed on unreadable protection %j', async protection => {
  const s = scenario(); s.protection = [protection];
  const calls = await run(s, 2, 'required checks unreadable from branch protection');
  expect(calls.filter(a => a.includes('PUT') || a[1]?.includes('check_name='))).toEqual([]);
});
it('uses explicit fallback when protection cannot be read', async () => {
  const s = scenario(); s.protection = [{ code: 1 }];
  expectMerge(await run(s, 0, 'USING EXPLICIT FALLBACK', undefined, { LAND_ALLOW_FALLBACK_CHECKS: '1' }), U);
});
it('rejects invalid fallback flag', async () => {
  await run({}, 2, 'invalid LAND_ALLOW_FALLBACK_CHECKS', undefined, { LAND_ALLOW_FALLBACK_CHECKS: 'yes' });
});
it('encodes spaces in protection check names', async () => {
  const s = scenario(); s.protection = [response({ checks: [{ context: 'build app', app_id: 15368 }] })];
  s['check-runs:build%20app'] = [runs('build app')];
  expectMerge(await run(s, 0, 'build app(app 15368)'), U);
});
it.each(['success', 'failure', 'in_progress'])('uses only latest check run: %s', async latest => {
  const s = scenario(latest === 'success' ? undefined : [pr()]);
  const old = runs('ci', U, 'completed', latest === 'success' ? 'failure' : 'success').stdout.check_runs[0];
  const newer = runs('ci', U, latest === 'in_progress' ? latest : 'completed', latest).stdout.check_runs[0];
  s['check-runs:ci'] = [response({ check_runs: [{ ...newer, id: 20 }, { ...old, id: 10 }] })];
  await run(s, latest === 'success' ? 0 : latest === 'failure' ? 3 : 4, latest === 'success' ? 'merged and verified' : latest === 'failure' ? 'FAILED' : 'timed out');
});
it.each(['success', 'failure', 'pending'])('uses latest app-less commit status: %s', async state => {
  const s = scenario(state === 'success' ? undefined : [pr()]);
  s.protection = [response({ contexts: ['ci'] })]; s['check-runs:ci'] = [response({ check_runs: [] })];
  s.statuses = [statuses([{ context: 'ci', state: 'success', id: 1 }, { context: 'ci', state, id: 2 }])];
  await run(s, state === 'success' ? 0 : state === 'failure' ? 3 : 4, state === 'success' ? 'merged and verified' : state === 'failure' ? 'FAILED' : 'timed out');
});
it.each(['CLOSED', 'MERGED', 'DRAFT'])('rejects pin precondition %s before protection', async state => {
  const s = scenario([state === 'DRAFT' ? pr(U, 'DRAFT') : pr(U, 'CLEAN', state)]);
  const calls = await run(s, 2, state === 'DRAFT' ? 'draft' : `PR is ${state}`);
  expect(calls.filter(a => a[1] !== 'view')).toEqual([]);
});
it('allows explicitly selected non-main base through to protection', async () => {
  const view = pr(); view.stdout.baseRefName = 'release';
  const s = scenario([view]); s.protection = [{ code: 1 }];
  const calls = await run(s, 2, 'unreadable', undefined, { LAND_BASE: 'release' });
  expect(calls).toContainEqual(['api', 'repos/{owner}/{repo}/branches/release/protection/required_status_checks']);
});
it.each([false, true])('refuses unverifiable landed tree: missing=%s', async missing => {
  const merged = pr(U, 'CLEAN', 'MERGED'); merged.stdout.mergeCommit.oid = missing ? 'a'.repeat(40) : M;
  await run(scenario([pr(), pr(), pr(), merged]), 9, missing ? 'could not read' : 'do NOT auto-revert');
});

it('reports the proven update chain on success', async () => {
  const calls = await run(scenario([pr(H, 'BEHIND'), pr(U), pr(U), pr(U), pr(U, 'CLEAN', 'MERGED')]), 0, `update chain: ${H} -> ${U} (main ${M})`);
  expect(calls.output).toContain(`update round 1/3: old head ${H} -> new head ${U}`);
});
it.each(['failure', 'pending', 'success'])('combines latest status and run: status=%s', async state => {
  const s = scenario(state === 'success' ? undefined : [pr()]);
  s.protection = [response({ checks: [{ context: 'ci', app_id: null }] })];
  s.statuses = [statuses([{ context: 'ci', state, id: 2 }])];
  await run(s, state === 'failure' ? 3 : state === 'pending' ? 4 : 0, state === 'failure' ? 'FAILED' : state === 'pending' ? 'timed out' : 'merged and verified');
});
it('documents deadline, protection, tree read-back and supervised first run', () => {
  const header = readFileSync(script, 'utf8').split('set -u')[0];
  for (const text of ['<pr-number> <reviewed-head-sha>', 'LAND_DEADLINE', 'LAND_CALL_TIMEOUT', 'LAND_ALLOW_FALLBACK_CHECKS', 'fallback only', '8  overall', '9  merged', '11 the head is an update of the reviewed head']) expect(header).toContain(text);
  expect(header).toContain('10 reserved');
  expect(header).not.toContain('10 updated');
  const skill = readFileSync(fileURLToPath(new URL('../.codex/skills/land/SKILL.md', import.meta.url)), 'utf8');
  for (const text of ['First live run', 'supervision by Release', '| 8 |', '| 9 |', '| 11 |', 'latest run', 'commit status', 'tree', 'update chain', 'passing review and QA verdict', 'land_strict_merge.sh "$PR_NUMBER" "$REVIEWED_HEAD"']) expect(skill).toContain(text);
  expect(skill).not.toMatch(/\| 10 \| Updated the branch/);
});

it('stops 9, not 8, when the post-merge tree fetch hits the deadline', async () => {
  writeFileSync(join(root, 'git'), `#!/bin/bash
if [ "$1" = fetch ] && [ "\${!#}" = '${S}' ]; then
  sleep 30
else
  exec '${realGit}' "$@"
fi
`, { mode: 0o755 });
  const start = Date.now();
  const calls = await run(scenario(), 9, 'could not read merge commit', undefined, { LAND_DEADLINE: '3', PATH: root + ':' + process.env.PATH });
  expect(Date.now() - start).toBeLessThan(10000);
  expectMerge(calls, U);
});
it('stops before a poll sleep that would cross the deadline', async () => {
  const s = scenario([pr()]); s['check-runs:ci'] = [runs('ci', U, 'in_progress')];
  const start = Date.now();
  await run(s, 8, 'poll would cross deadline', undefined, { LAND_SLEEP: 'sleep', LAND_POLL_INTERVAL: '5', LAND_CHECK_POLLS: '10', LAND_DEADLINE: '3' });
  expect(Date.now() - start).toBeLessThan(4500);
});
it('a protection read killed by the deadline exits 8, not the fail-closed 2', async () => {
  const s = scenario(); s.protection = [{ sleep: 30, ...s.protection[0] }];
  const calls = await run(s, 8, 'deadline', undefined, { LAND_DEADLINE: '2' });
  expect(calls.filter(a => a.includes('PUT') || a[1]?.includes('check_name='))).toEqual([]);
});

it.each([
  ['an exited parent with a descendant holding stdout', 'sleep 6 &', 3000],
  ['a command and descendant ignoring TERM', 'trap "" TERM; sleep 6', 5000],
  ['an exited parent leaving a TERM-resistant descendant', '(trap "" TERM; sleep 6) & wait', 5000],
])('bounds command substitution with %s', async (_name, command, maxElapsed) => {
  const bounded = readFileSync(script, 'utf8').match(/^bounded\(\) \{\n[\s\S]*?^\}/m)?.[0];
  expect(bounded).toBeTruthy();
  const start = Date.now();
  // Keep stdout captured: an orphan holding this pipe must delay completion
  // and fail the elapsed-time assertion if group cleanup is removed.
  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', `${bounded}\nvalue=$(bounded 1 bash -c "$1"); printf 'returned'`, 'bounded-test', command]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('returned');
  expect(Date.now() - start).toBeLessThan(maxElapsed);
});

it.each(['truncated', 'wrong sha', 'array', 'missing count', 'string count', 'missing statuses'])('rejects invalid combined status: %s', async kind => {
  const s = scenario([pr()]);
  s.protection = [response({ contexts: ['ci'] })];
  // A successful same-name run must never mask an unverifiable status source.
  const items = Array.from({ length: 100 }, (_, id) => ({ context: `other-${id}`, state: 'success', id }));
  const invalid = {
    truncated: { sha: U, total_count: 150, statuses: items },
    'wrong sha': { sha: H, total_count: 0, statuses: [] },
    array: [],
    'missing count': { sha: U, statuses: [] },
    'string count': { sha: U, total_count: '0', statuses: [] },
    'missing statuses': { sha: U, total_count: 0 },
  }[kind];
  s.statuses = [response(invalid)];
  const calls = await run(s, 4, 'timed out waiting for required checks');
  expect(calls.filter(a => a[1]?.includes('/status?'))).toEqual(Array(2).fill(['api', `repos/{owner}/{repo}/commits/${U}/status?per_page=100`]));
});

it('routes an already-expired deadline before post-merge fetch to 9', () => {
  const source = readFileSync(script, 'utf8');
  const stop = source.match(/^stop\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const deadline = source.match(/^deadline\(\) \{.*$/m)?.[0];
  expect(stop).toBeTruthy(); expect(deadline).toBeTruthy();
  const result = spawnSync('bash', ['-c', `${stop}\n${deadline}\nMERGE_SENT=true; MERGED_SEEN=true; LAND_DEADLINE=1; DEADLINE_AT=0; deadline`], { encoding: 'utf8' });
  expect(result.status).toBe(9);
  expect(result.stderr).toContain('MERGED but the post-merge read-back did not finish before the overall deadline; do not mark Done, do NOT auto-revert, escalate to Human Review');
});

it('preserves known MERGED when a later poll would cross the deadline', async () => {
  const merged = pr(U, 'CLEAN', 'MERGED'); merged.stdout.mergeCommit = null;
  const calls = await run(scenario([pr(), pr(), pr(), merged]), 9, 'MERGED but the post-merge read-back did not finish before the overall deadline', undefined, { LAND_DEADLINE: '10', LAND_POLL_INTERVAL: '15' });
  expectMerge(calls, U);
});
