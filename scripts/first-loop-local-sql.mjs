/** Optional proof on the maintained runner's exclusively owned compatibility clone.
 * No process, network, credential, grant or resource creation occurs on import.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const sha = value => createHash('sha256').update(value).digest('hex');
export const fixtureSha256 = 'f2909462eaf02d28b3fbd268e95fc6c384a19c3b80e265611b882eea5116a75d';
export const stages = [
  {
    "path": "docs/release/ovd561-pending-forward.sql",
    "sha256": "6d6875f9b3fd8cad2a6d885efb61c277f66c183d73b6a904da46a66ac04bb548"
  },
  {
    "path": "scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql",
    "sha256": "334c4ae302263df13c7702159bd6355aa4cfb753e1d309ae5e035ba9424d2a18"
  },
  {
    "path": "docs/release/private-artifact-forward.sql",
    "sha256": "80f88179f4e61ec44498bc25e18b0ce33aba433326dbdc1c9503a80cb969924b"
  },
  {
    "path": "docs/release/native-artifact-mapping-forward.sql",
    "sha256": "e21234f40c17509f02555212d21d84684a5788bd386fbcf4389fa0afc2de36ba"
  },
  {
    "path": "docs/release/native-result-reader-forward.sql",
    "sha256": "e5f4b7fe8253efd03e082f88e8b4c1e5799503bcac95c0527c147b94b765e772"
  }
];

const authoritySources = [
  {
    "path": "docs/release/ovd-558-verifier-authority-forward.sql",
    "sha256": "a1e6b52443cd1888ff0e287e3564d0c6090d77c6a75d6bd6ded5708b008c383c"
  },
  {
    "path": "docs/release/ovd-558-verifier-authority-reverse.sql",
    "sha256": "575ffe331264e30a1399a3bb7d9eff747d564b3c9d8b79f270573038cb63e961"
  },
  {
    "path": "docs/release/ovd-560-result-registry-forward.sql",
    "sha256": "f5d855a8937b8f96c9b3242ca6242a658c3af6fdbbe3250d982ef047c0e8bbcd"
  },
  {
    "path": "docs/release/ovd-560-result-registry-reverse.sql",
    "sha256": "a33d52aea49fbf637ee11d4ef018f7be94e3266d6df66cf4eb2bf7e9a44be024"
  },
  {
    "path": "docs/release/ovd-561-finalization-forward.sql",
    "sha256": "0c13ffc1841b59d0a86294b52f54ccb01837d4c2e90e59e12dab8e4679022412"
  },
  {
    "path": "docs/release/ovd-561-finalization-reverse.sql",
    "sha256": "db8a3955c34d35d4b16f9b47f4a8b5777ac784af48726d7bd46a4e0a31ef93c5"
  },
  {
    "path": "docs/release/ovd-560-result-registry-proof.sql",
    "sha256": "1daebb5948202928999d6bd4a09b40085f363b5390317e854cf9fba11c066d80"
  },
  {
    "path": "docs/release/ovd-561-finalization-proof.sql",
    "sha256": "9cb62aa0e1faef16e1f1d0110437828c39a6edc0a853065c6545817dd7e04f06"
  }
];

export function loadFirstLoopProof(root, packetDirectory) {
  for (const source of authoritySources) {
    if (sha(readFileSync(join(root, source.path))) !== source.sha256) throw new Error(`first_loop_authority_source_drift:${source.path}`);
  }
  reviewedAuthorityNames(root);
  const fixture = readFileSync(join(packetDirectory, 'first-loop.sql'), 'utf8');
  if (sha(fixture) !== fixtureSha256) throw new Error('first_loop_fixture_digest_mismatch');
  const sources = stages.map(stage => {
    const sql = readFileSync(join(root, stage.path), 'utf8');
    if (sha(sql) !== stage.sha256) throw new Error(`first_loop_stage_drift:${stage.path}`);
    return { ...stage, sql };
  });
  return { fixture, sources };
}

export function checkTap(output) {
  const plans = [...output.matchAll(/^1\.\.(\d+)\s*$/gm)];
  const assertions = [...output.matchAll(/^ok (\d+)\b.*$/gm)];
  const count = Number(plans[0]?.[1]);
  if (plans.length !== 1 || count < 1 || assertions.length !== count
      || assertions.some((entry, index) => Number(entry[1]) !== index + 1)
      || /^(not ok\b|Bail out!)/im.test(output)
      || /#\s*(SKIP|TODO)\b/i.test(output)
) throw new Error('first_loop_tap_failed');
  const diagnostics = output.split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value?.syntheticOnly === true ? [value] : []; }
    catch { return []; }
  });
  if (diagnostics.length !== 1 || !['taskId','attemptId','evidenceId'].every(key =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(diagnostics[0][key]))
      || !diagnostics[0].stopReceipt || typeof diagnostics[0].stopReceipt !== 'object') {
    throw new Error('first_loop_diagnostic_missing');
  }
  return count;
}

// This is a local object capability supplied only at the maintained clone hook;
// it is neither an admission token nor an externally callable transport.
export async function runFirstLoopProof({ proof, session, record, deadline, now = Date.now }) {
  if (!Number.isFinite(deadline) || deadline <= now()) throw new Error('first_loop_deadline_exceeded');
  // Copy and validate all bytes before any SQL call, including injected tests.
  const fixture = String(proof.fixture);
  const sources = proof.sources.map(entry => ({ ...entry }));
  if (sha(fixture) !== fixtureSha256 || sources.length !== stages.length
      || sources.some((entry, i) => entry.path !== stages[i].path
        || entry.sha256 !== stages[i].sha256 || sha(entry.sql) !== entry.sha256)) {
    throw new Error('first_loop_source_mismatch');
  }
  const receipts = [];
  const retain = event => {
    let result;
    try { result = record(event); } catch { throw new Error('first_loop_record_failed'); }
    if (result !== undefined) {
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      throw new Error('first_loop_record_must_be_synchronous');
    }
  };
  const execute = async (name, sql, { identity = true } = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('first_loop_deadline_exceeded');
    const prefix = "set statement_timeout='30s'; set lock_timeout='5s';\n";
    const actual = prefix + (identity ? `do $identity$ begin
      if current_user <> 'postgres' or current_database() <> 'ovd561_seed' then
        raise exception 'first_loop_runner_identity_mismatch'; end if; end $identity$;
      select 'first_loop_identity:postgres:ovd561_seed';\n` : '') + sql;
    const receipt = { name, sqlSha256: sha(sql), executionSqlSha256: sha(actual),
      role: 'postgres', database: 'ovd561_seed', status: 'started', runtime: 'unresolved', startedAt: new Date(now()).toISOString() };
    receipts.push(receipt);
    retain({ ...receipt }); // Durable intent before possible mutation.
    let response;
    try { response = await session(actual, Math.min(240_000, remaining)); }
    catch {
      receipt.status = 'outcome_unknown'; retain({ ...receipt }); throw new Error(`first_loop_session_outcome_unknown:${name}`);
    }
    Object.assign(receipt, { code: response.code, stdout: response.stdout, stderr: response.stderr,
      outputOverflow: response.outputOverflow === true, signal: response.signal ?? null, timedOut: response.timedOut === true });
    if (response.code !== 0 || response.outputOverflow || response.timedOut || response.signal || !response.stdout.includes('first_loop_identity:postgres:ovd561_seed') || now() >= deadline) {
      receipt.status = 'failed_or_unknown'; retain({ ...receipt });
      throw new Error(`first_loop_execution_failed:${name}`);
    }
    receipt.status = 'executed'; receipt.runtime = 'executed';
    receipt.completedAt = new Date(now()).toISOString(); retain({ ...receipt });
    return response.stdout;
  };
  // Check pre-existing role transitions before applying any new stage. No grants.
  await execute('access', `begin; set local role ovd575_observer_validator;
    reset role; set local role ovd576_stop_validator; reset role; rollback;`);
  for (const entry of sources) await execute(entry.path, entry.sql);
  const snapshotSql = `begin;
    create temporary table first_loop_snapshot(name text, digest text) on commit drop;
    do $snapshot$ declare t record; begin
      for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','engineering_private','storage','auth') and c.relkind='r'
        order by n.nspname,c.relname loop
        execute format('insert into first_loop_snapshot select %L,md5(coalesce(string_agg(row_to_json(r)::text,chr(10) order by row_to_json(r)::text),%L)) from %I.%I r',
          t.nspname||'.'||t.relname,'',t.nspname,t.relname);
      end loop; end $snapshot$;
    select json_agg(s order by name) from first_loop_snapshot s; rollback;`;
  const snapshot = output => {
    const rows = output.split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return Array.isArray(value) ? [value] : []; } catch { return []; }
    });
    const expected = ['auth.users','storage.objects','storage.buckets','public.engineering_execution_attempts'];
    if (rows.length !== 1 || rows[0].length === 0
        || rows[0].some(row => typeof row.name !== 'string' || !/^[0-9a-f]{32}$/.test(row.digest))
        || new Set(rows[0].map(row => row.name)).size !== rows[0].length
        || expected.some(name => !rows[0].some(row => row.name === name))) throw new Error('first_loop_snapshot_invalid');
    return JSON.stringify(rows[0]);
  };
  const before = snapshot(await execute('rollback-before', snapshotSql));
  let output;
  try { output = await execute('first-loop.sql', fixture); }
  catch (error) { retain({ name: 'rollback', status: 'unresolved', reason: 'execution_failed_or_unknown' }); throw error; }
  let assertions, tapFailure;
  try { assertions = checkTap(output); } catch (error) { tapFailure = error; }
  let after;
  try { after = snapshot(await execute('rollback-after', snapshotSql)); }
  catch (error) { retain({ name: 'rollback', status: 'unresolved', reason: 'snapshot_failed' }); throw error; }
  if (before !== after) { retain({ name: 'rollback', status: 'failed' }); throw new Error('first_loop_rollback_drift'); }
  retain({ name: 'rollback', status: 'passed', snapshotSha256: sha(after) });
  if (tapFailure) throw tapFailure;
  return { assertions, receipts, rollback: 'exact_relation_snapshot_restored',
    resourceCleanup: 'owned_by_parent_fixture', storageTransport: 'unrun', native: 'unrun' };
}

export function reviewedAuthorityNames(root) {
  const frozen = JSON.parse(readFileSync(join(root, 'scripts/first-loop-authority-baseline.json'), 'utf8'));
  const reviewed = JSON.parse(readFileSync(join(root, 'docs/release/ovd-510-prechange-compatibility-manifest.json'), 'utf8'));
  if (frozen.sourceRevision !== reviewed.fixture.sourceRevision) throw new Error('authority_baseline_revision_mismatch');
  const names = frozen.files.map(entry => entry.name);
  if (new Set(names).size !== names.length || names.some(name => !/^\d+_[a-zA-Z0-9_-]+\.sql$/.test(name))) throw new Error('authority_baseline_name_mismatch');
  const manifest = names.sort((a,b) => a.localeCompare(b)).map(name => {
    const bytes = readFileSync(join(root, 'supabase/migrations', name));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== frozen.files.find(entry => entry.name === name).gitBlobSha1) throw new Error('authority_baseline_blob_mismatch');
    return { name, sha256: sha(bytes) };
  });
  if (sha(JSON.stringify(manifest)) !== reviewed.fixture.migrationManifestSha256) throw new Error('authority_baseline_manifest_mismatch');
  return names;
}

export function redactFixtureTranscript(value, fixturePassword) {
  const text = String(value);
  return fixturePassword ? text.split(fixturePassword).join('[fixture-secret-redacted]') : text;
}
