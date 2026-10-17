// @vitest-environment node
// OVD-889: runs the real .codex/skills/land/land_strict_merge.sh against a stub
// gh and real git repos (a bare origin plus a clone, built once and copied per
// test). The temp path contains a space, so an unquoted expansion in the script
// breaks these tests. The script runs through async spawn so a slow run never
// blocks the vitest worker.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

// Real git plus bash per test; allow for slow CI runners.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const script = fileURLToPath(new URL('../.codex/skills/land/land_strict_merge.sh', import.meta.url));
let template, root, cwd, B, H, M, U, R, X, W;
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
let kind = args[0]==='pr' && args[1]==='view' ? 'pr-view' : args[0]==='pr' && args[1]==='merge' ? 'merge' : args.includes('PUT') ? 'update-branch' : args.join(' ').includes('check_name=') ? 'check-runs:'+args.join(' ').match(/check_name=([^&]+)/)[1] : 'unknown';
const path = process.env.LAND_STUB_LOG+'.counts';
const counts = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : {};
const responses = scenario[kind];
if (!responses) process.exit(99);
const r = responses[Math.min(counts[kind] || 0, responses.length-1)];
counts[kind]=(counts[kind]||0)+1; fs.writeFileSync(path,JSON.stringify(counts));
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
const pr = (head = U, mergeStateStatus = 'CLEAN', state = 'OPEN') => response({ state, isDraft: false, mergeStateStatus, headRefOid: head, baseRefName: 'main', mergeCommit: { oid: M } });
const runs = (name, head = U, status = 'completed', conclusion = 'success', app = 15368) => response({ total_count: 1, check_runs: [{ name, head_sha: head, status, conclusion, app: { id: app } }] });
function scenario(views = [pr(), pr(), pr(), pr(U, 'CLEAN', 'MERGED')]) {
  return { 'pr-view': views, 'check-runs:ci': [runs('ci')], 'check-runs:provider-go-live': [runs('provider-go-live')], merge: [response('')], 'update-branch': [response('')] };
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
async function run(s, code, message, args = ['7'], env = {}) {
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(s));
  const r = await runScript(args, { ...process.env, LAND_GH: join(root, 'gh'), LAND_STUB_SCENARIO: join(root, 'scenario.json'), LAND_STUB_LOG: join(root, 'log'), LAND_SLEEP: 'true', LAND_POLL_INTERVAL: '0', LAND_HEAD_POLLS: '2', LAND_CHECK_POLLS: '2', LAND_MERGEABLE_POLLS: '2', LAND_MERGE_POLLS: '2', ...env });
  expect(r.status, r.stderr).toBe(code); expect(r.stderr + r.stdout).toContain(message);
  const calls = existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  expect(calls.every(a => ['pr', 'api'].includes(a[0]))).toBe(true);
  if (code !== 0 && !message.includes('differs from the verified head') && !message.includes('merge refused') && !message.includes('merge not verified')) expect(calls.filter(a => a[1] === 'merge')).toEqual([]);
  return calls;
}
function expectMerge(calls, pin) {
  expect(calls.filter(a => a[1] === 'merge')).toEqual([['pr', 'merge', '7', '--squash', '--match-head-commit', pin]]);
}
it('merges an up to date head pinned exactly', async () => {
  const calls = await run(scenario(), 0, 'merged and verified'); expectMerge(calls, U);
  expect(calls.some(a => a.includes('PUT'))).toBe(false);
});
it('updates behind main, ignores stale checks, waits for the merge head', async () => {
  const s = scenario([pr(H, 'BEHIND'), pr(H), pr(U), pr(U), pr(U), pr(U, 'CLEAN', 'MERGED')]);
  s['check-runs:ci'][0].stdout.check_runs.push(runs('ci', H, 'completed', 'failure').stdout.check_runs[0]);
  const calls = await run(s, 0, 'new pinned head'); expectMerge(calls, U);
  expect(calls.filter(a => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/7/update-branch', '-f', `expected_head_sha=${H}`]]);
  expect(calls.filter(a => a[0] === 'api' && !a.includes('PUT')).every(a => a[1].includes(`/commits/${U}/`))).toBe(true);
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
it.each(['short', 'long', 'upper', 'newline', 'injection', 'empty'])('rejects malformed SHA: %s', async kind => {
  const bad = { short: H.slice(1), long: H+'a', upper: 'A'.repeat(40), newline: H+'\n', injection: H+'\n$(touch pwned)', empty: '' }[kind];
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
  const calls = await run(s, 7, 'update rounds used', ['7'], { LAND_MAX_UPDATES: '1' }); expect(calls.filter(a => a.includes('PUT'))).toHaveLength(1);
});
it('fails closed on unreadable PR', async () => await run(scenario([{ code: 1 }]), 5, 'PR unreadable'));
it.each([[], ['abc'], ['07'], ['1;rm']])('rejects usage %j without gh', async (...args) => {
  // Vitest spreads array rows; normalize the single argument rows.
  const argv = typeof args[0] === 'string' ? [args[0]] : [];
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
  expect(await run({}, 2, 'invalid numeric configuration', ['7'], { LAND_CHECK_POLLS: count })).toEqual([]);
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
  await run(scenario([other]), 2, "expected 'main'");
});
it('rejects an unknown merge state', async () => await run(scenario([pr(U, 'SOMETHING_NEW')]), 5, 'unknown merge state'));
it('rejects an update merge whose first parent is not the pinned head', async () => {
  await run(scenario([pr(H, 'BEHIND'), pr(W)]), 5, 'not the pinned');
});
