import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildPlan, classifyLedger, compareCatalogs, buildFaultCopy,
  MANIFEST_SCHEMA, CATALOG_SCHEMA, CATALOG_COVERAGE,
} from './core.mjs';

// Invented source and observations only. No historical ledger or SQL execution.
const sha = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const versions = Array.from({ length: 5 }, (_, i) => `2099010100000${i}`);
function fixture() {
  const sourceFiles = new Map();
  const migrations = versions.map((version, i) => {
    const path = `supabase/migrations/${version}_synthetic_${i}.sql`;
    const bytes = Buffer.from(`-- invented migration ${i}\nBEGIN;\nCREATE TABLE synthetic_${i}(id integer);\nCOMMIT;\n`);
    sourceFiles.set(path, bytes);
    return { path, version, sha256: sha(bytes) };
  });
  sourceFiles.set('scripts/synthetic-profile.json', Buffer.from('{"synthetic":true}\n'));
  const inputs = [...sourceFiles].map(([path, bytes]) => ({ path, sha256: sha(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { manifest: { schema: MANIFEST_SCHEMA, sourceCommit: 'a'.repeat(40), migrations, inputs }, sourceFiles, baselineVersions: [versions[0], versions[3]] };
}
const row = (version) => ({ version, name: 'invented_' + version, statements: ['-- synthetic observed representation\nSELECT 1', 'SELECT 2'] });
function ledgerFixture() {
  const input = fixture();
  return { plan: buildPlan(input), baselineLedger: input.baselineVersions.map(row), currentLedger: input.baselineVersions.map(row) };
}
function catalogFixture() {
  return {
    schema: CATALOG_SCHEMA, coverage: [...CATALOG_COVERAGE], records: [
      { kind: 'schema', identity: 'synthetic', owner: 'owner_a', acl: null },
      { kind: 'role', identity: 'owner_a', attributes: { superuser: false, inherit: true, createRole: false, createDb: false,
        canLogin: true, replication: false, bypassRls: false, connectionLimit: -1, validUntil: null }, memberships: [{ role: 'synthetic_read', grantor: 'owner_a', admin: false, inherit: true, set: true }] },
      { kind: 'relation', identity: 'synthetic.t', owner: 'owner_a', acl: [{ grantor: 'owner_a', grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }],
        rls: true, forceRls: true, definition: { columns: [{ name: 'id', type: 'integer', default: null }], constraints: [] } },
      { kind: 'function', identity: 'synthetic.f(integer)', owner: 'owner_a', acl: [], definition: 'SELECT $1', securityDefiner: false, configuration: ['search_path='] },
      { kind: 'policy', identity: 'synthetic.t/read', relation: 'synthetic.t', roles: ['synthetic_read', 'owner_a'], command: 'SELECT', permissive: true, using: '(id > 0)', withCheck: null },
      { kind: 'defaultPrivilege', identity: 'owner_a/synthetic/tables', owner: 'owner_a', schema: 'synthetic', objectType: 'table', acl: [] },
    ],
  };
}

test('non-prefix synthetic baseline partitions the exact closed candidate once in candidate order', () => {
  const input = fixture(); const plan = buildPlan(input);
  assert.equal(plan.qualification, 'synthetic-only');
  assert.deepEqual(plan.canonical.map((entry) => entry.version), versions);
  assert.deepEqual(plan.baseline.map((entry) => entry.version), [versions[0], versions[3]]);
  assert.deepEqual(plan.absent.map((entry) => entry.version), [versions[1], versions[2], versions[4]]);
  assert.equal(new Set([...plan.baseline, ...plan.absent].map((entry) => entry.version)).size, 5);
  assert.equal(plan.inputs.length, 6);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(buildPlan({ ...input, sourceFiles: new Map([...input.sourceFiles].reverse()) }), plan);
});

test('plan snapshots cannot be changed through input references or returned nested records', () => {
  const input = fixture(); const plan = buildPlan(input); const original = JSON.stringify(plan);
  input.manifest.migrations[0].path = 'changed'; input.baselineVersions.reverse(); input.sourceFiles.clear();
  assert.equal(JSON.stringify(plan), original);
  assert.throws(() => { plan.baseline[0].sha256 = 'b'.repeat(64); }, TypeError);
  assert.throws(() => plan.absent.push({}), TypeError);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(plan))), original);
});

test('hyphenated migration basenames preserve exact version and byte binding', () => {
  const input = fixture(); const entry = input.manifest.migrations[0]; const previous = entry.path;
  const renamed = `supabase/migrations/${entry.version}_01234567-89ab-cdef-0123-456789abcdef.sql`;
  input.manifest.inputs.find((item) => item.path === previous).path = renamed;
  entry.path = renamed;
  input.sourceFiles.set(renamed, input.sourceFiles.get(previous)); input.sourceFiles.delete(previous);
  const plan = buildPlan(input); assert.equal(plan.canonical[0].path, renamed);
  assert.equal(plan.canonical[0].sha256, sha(input.sourceFiles.get(renamed)));
});

test('baseline rejects unknown, duplicate, reordered and untyped versions without prefix assumptions', () => {
  for (const baselineVersions of [['20990101999999'], [versions[0], versions[0]], [versions[3], versions[0]], [20990101000000], null]) {
    assert.throws(() => buildPlan({ ...fixture(), baselineVersions }));
  }
  assert.equal(buildPlan({ ...fixture(), baselineVersions: [] }).absent.length, 5);
  assert.equal(buildPlan({ ...fixture(), baselineVersions: versions }).absent.length, 0);
});

test('source closure rejects missing, substituted, extra, non-Buffer and drifted bytes including nonmigration profile', () => {
  const operations = [
    (input) => input.sourceFiles.delete(input.manifest.migrations[0].path),
    (input) => input.sourceFiles.set('extra.sql', Buffer.from('extra')),
    (input) => input.sourceFiles.set('scripts/synthetic-profile.json', Buffer.from('drift')),
    (input) => input.sourceFiles.set(input.manifest.migrations[2].path, Buffer.from('drift')),
    (input) => input.sourceFiles.set(input.manifest.migrations[2].path, 'not bytes'),
    (input) => { input.sourceFiles.delete('scripts/synthetic-profile.json'); input.sourceFiles.set('wrong.json', Buffer.from('{"synthetic":true}\n')); },
  ];
  for (const mutate of operations) { const input = fixture(); mutate(input); assert.throws(() => buildPlan(input)); }
});

test('manifest rejects identity, order, path, duplicate, missing-input and hidden migration errors', () => {
  const operations = [
    (m) => { m.schema = 'unknown'; }, (m) => { m.sourceCommit = ['a'.repeat(40)]; },
    (m) => { m.sourceCommit = 'a'.repeat(39); }, (m) => { m.extra = true; },
    (m) => m.migrations.reverse(), (m) => m.migrations.push(m.migrations[0]),
    (m) => { m.migrations[0].version = '2024'; },
    (m) => { m.migrations[0].path = '../outside.sql'; },
    (m) => { m.migrations[0].path = '/supabase/migrations/x.sql'; },
    (m) => { m.migrations[0].sha256 = 'f'.repeat(64); },
    (m) => m.inputs.reverse(), (m) => m.inputs.splice(1, 1),
    (m) => { m.inputs[0].path = 'scripts/../outside.json'; },
    (m) => { m.inputs[0].path = 'scripts\\outside.json'; },
    (m) => { m.inputs[0].sha256 = 'not-hash'; },
    (m) => m.inputs.push({ path: 'supabase/migrations/20990101999999_hidden.sql', sha256: 'f'.repeat(64) }),
  ];
  for (const mutate of operations) { const input = fixture(); mutate(input.manifest); assert.throws(() => buildPlan(input)); }
});

test('plain-JSON contract rejects getters, sparse arrays, extra properties, symbols and undefined', () => {
  const input = fixture(); let called = false;
  Object.defineProperty(input.manifest, 'sourceCommit', { enumerable: true, get() { called = true; return 'a'.repeat(40); } });
  assert.throws(() => buildPlan(input)); assert.equal(called, false);
  for (const mutate of [
    (m) => { delete m.migrations[2]; }, (m) => { m.inputs.extra = true; },
    (m) => { m[Symbol('hidden')] = true; }, (m) => { m.extra = undefined; },
    (m) => { Object.defineProperty(m, 'hidden', { value: true }); },
  ]) { const item = fixture(); mutate(item.manifest); assert.throws(() => buildPlan(item)); }
});

test('plan identity binds source commit, full profile closure and baseline selection', () => {
  const input = fixture(); const first = buildPlan(input);
  const second = buildPlan({ ...input, baselineVersions: [versions[1]] });
  assert.notEqual(first.planSha256, second.planSha256); assert.equal(first.manifestSha256, second.manifestSha256);
  input.manifest.sourceCommit = 'b'.repeat(40);
  assert.notEqual(first.manifestSha256, buildPlan(input).manifestSha256);
});

test('ledger classifies baseline, completed absent-prefix and final independently of row order', () => {
  const input = ledgerFixture();
  assert.equal(classifyLedger(input).status, 'baseline');
  input.currentLedger.unshift(row(versions[1]));
  const prefix = classifyLedger(input);
  assert.equal(prefix.status, 'completed-prefix'); assert.deepEqual(prefix.completedVersions, [versions[1]]);
  assert.deepEqual(prefix.pendingVersions, [versions[2], versions[4]]);
  assert.equal(prefix.safeToResume, false); assert.equal(prefix.catalogEvidence, 'not-compared');
  input.currentLedger.push(row(versions[2]), row(versions[4]));
  const final = classifyLedger(input);
  assert.equal(final.status, 'final'); assert.equal(final.safeToResume, false);
  assert.deepEqual(classifyLedger({ ...input, currentLedger: [...input.currentLedger].reverse() }), final);
  assert.equal(classifyLedger({ plan: buildPlan({ ...fixture(), baselineVersions: versions }), baselineLedger: versions.map(row), currentLedger: versions.map(row) }).status, 'final');
});

test('ledger refuses unknown/missing baseline, changed names/statements and non-prefix absent application', () => {
  for (const mutate of [
    (x) => x.currentLedger.push(row('20990101999999')),
    (x) => x.currentLedger.shift(),
    (x) => { x.currentLedger[0].name = 'changed'; },
    (x) => { x.currentLedger[0].statements.reverse(); },
    (x) => { x.currentLedger[0].statements[0] += ';'; },
    (x) => { x.currentLedger[0].statements = null; },
    (x) => x.currentLedger.push(row(versions[2])),
  ]) {
    const input = ledgerFixture(); mutate(input); const outcome = classifyLedger(input);
    assert.equal(outcome.status, 'drift'); assert.ok(outcome.reasons.length); assert.equal(outcome.safeToResume, false);
  }
});

test('malformed ledger or baseline inputs reject instead of manufacturing observations', () => {
  for (const mutate of [
    (x) => x.currentLedger.push(x.currentLedger[0]),
    (x) => { x.currentLedger[0].statements = 'f'.repeat(64); },
    (x) => { x.currentLedger[0].statements = [123]; },
    (x) => { x.currentLedger[0].sha256 = 'f'.repeat(64); },
    (x) => { x.currentLedger[0].name = 123; },
    (x) => { delete x.currentLedger[0].statements; },
    (x) => x.baselineLedger.pop(), (x) => x.baselineLedger.push(row(versions[1])),
    (x) => { x.baselineLedger[0].version = 20990101000000; },
  ]) { const input = ledgerFixture(); mutate(input); assert.throws(() => classifyLedger(input)); }
});

test('actual null and empty CLI statement arrays stay distinct; no file-hash equality is inferred', () => {
  const input = ledgerFixture(); input.currentLedger.push({ version: versions[1], name: null, statements: null });
  const nullValue = classifyLedger(input);
  input.currentLedger.at(-1).statements = [];
  const emptyValue = classifyLedger(input);
  assert.equal(nullValue.status, 'completed-prefix'); assert.equal(emptyValue.status, 'completed-prefix');
  assert.notEqual(nullValue.ledgerSha256, emptyValue.ledgerSha256);
  assert.equal(emptyValue.statementEvidence, 'observed-only');
  assert.equal(emptyValue.safeToResume, false);
});

test('modified serialized plan is refused even when malformed plan still looks plausible', () => {
  for (const mutate of [
    (p) => p.absent.reverse(), (p) => { p.baseline[0].sha256 = 'c'.repeat(64); },
    (p) => { p.planSha256 = 'c'.repeat(64); }, (p) => { p.qualification = 'production'; },
    (p) => p.canonical.pop(),
  ]) { const input = ledgerFixture(); input.plan = copy(input.plan); mutate(input.plan); assert.throws(() => classifyLedger(input)); }
});

test('catalog compares named records regardless of row/object-key order, without changing inputs', () => {
  const left = catalogFixture(); const right = copy(left);
  right.records.reverse(); right.coverage.reverse();
  right.records = right.records.map((r) => Object.fromEntries(Object.entries(r).reverse()));
  const before = JSON.stringify([left, right]); const outcome = compareCatalogs(left, right);
  assert.equal(outcome.equal, true); assert.equal(outcome.leftSha256, outcome.rightSha256);
  assert.equal(outcome.qualification, 'supplied-records-only'); assert.equal(JSON.stringify([left, right]), before);
  assert.throws(() => outcome.changed.push('altered'), TypeError);
});

test('catalog preserves owners, ACL/null/defaults, RLS, roles, definitions, policies, arrays and OIDs', () => {
  const mutations = [
    (r) => { r[0].owner = 'different_owner'; }, (r) => { r[0].acl = []; },
    (r) => { r[1].attributes.createRole = true; }, (r) => { r[1].memberships[0].admin = true; },
    (r) => { r[2].acl[0].grantable = true; }, (r) => { r[2].rls = false; },
    (r) => { r[2].forceRls = false; }, (r) => { r[2].definition.columns[0].default = '42'; },
    (r) => { r[2].oid = 12345; }, (r) => { r[3].definition = 'SELECT 0'; },
    (r) => { r[3].securityDefiner = true; }, (r) => { r[3].configuration.push('role=owner_a'); },
    (r) => { r[4].using = '(id > 1)'; }, (r) => { r[4].roles.reverse(); },
    (r) => { r[5].acl = null; }, (r) => { r[5].schema = null; },
  ];
  for (const mutate of mutations) {
    const left = catalogFixture(); const right = copy(left); mutate(right.records);
    const outcome = compareCatalogs(left, right); assert.equal(outcome.equal, false);
    assert.equal(outcome.changed.length, 1); assert.notEqual(outcome.leftSha256, outcome.rightSha256);
  }
});

test('catalog unknown/incomplete envelopes and semantic records fail closed', () => {
  for (const mutate of [
    (c) => { c.schema = 'unknown'; }, (c) => c.coverage.pop(), (c) => c.coverage.push('owners'),
    (c) => { c.coverage[0] = c.coverage[1]; }, (c) => { c.records = []; },
    (c) => c.records.push(c.records[0]), (c) => { c.records[0].kind = 'unknown'; },
    (c) => { delete c.records[0].owner; }, (c) => { c.records[2].rls = 'true'; },
    (c) => { delete c.records[1].attributes.bypassRls; }, (c) => { c.records[3].definition = ''; },
    (c) => { delete c.records[1].memberships[0].grantor; }, (c) => { c.records[2].acl = [123]; },
    (c) => { delete c.records[2].acl[0].grantable; },
    (c) => { c.records[4].roles = 'PUBLIC'; }, (c) => { c.records[5].acl = {}; },
  ]) { const value = catalogFixture(); mutate(value); assert.throws(() => compareCatalogs(value, catalogFixture())); }
});

test('catalog missing and extra named identities remain separately visible', () => {
  const left = catalogFixture(); const right = copy(left); right.records.shift();
  right.records.push({ kind: 'schema', identity: 'other', owner: 'owner_a', acl: [] });
  const outcome = compareCatalogs(left, right);
  assert.deepEqual(outcome.missing, [['schema', 'synthetic']]); assert.deepEqual(outcome.extra, [['schema', 'other']]);
  assert.deepEqual(outcome.changed, []); assert.equal(outcome.equal, false);
});

function faultInput(mode = 'in-file') {
  const bytes = Buffer.from('-- invented λ fixture\nBEGIN;\nCREATE TABLE synthetic_fault(id integer);\nCOMMIT;\n');
  const text = 'COMMIT;\n';
  return { bytes, expectedSha256: sha(bytes), mode, anchor: { text, offset: bytes.indexOf(text) } };
}

for (const mode of ['committed-prefix', 'in-file', 'commit-to-ledger']) {
  test(`fault ${mode} preserves every original byte and binds the precise disposable delta`, () => {
    const input = faultInput(mode);
    if (mode === 'committed-prefix') input.anchor = { text: '-- invented λ fixture\n', offset: 0 };
    const original = Buffer.from(input.bytes); const result = buildFaultCopy(input);
    const changed = Buffer.from(result.bytesBase64, 'base64');
    assert.ok(input.bytes.equals(original)); assert.equal(sha(changed), result.faultSha256);
    assert.notEqual(result.originalSha256, result.faultSha256); assert.equal(result.byteLength, changed.length);
    const offset = mode === 'committed-prefix' ? 0 : mode === 'in-file' ? input.anchor.offset : original.length;
    assert.equal(result.insertionOffset, offset);
    assert.ok(changed.subarray(0, offset).equals(original.subarray(0, offset)));
    assert.equal(changed.subarray(offset, offset + Buffer.byteLength(result.insertedSql)).toString(), result.insertedSql);
    assert.ok(changed.subarray(offset + Buffer.byteLength(result.insertedSql)).equals(original.subarray(offset)));
    assert.equal(result.qualification, 'placement-only'); assert.equal(result.runtimeBoundary, 'not-run');
    assert.equal(changed.toString().split(result.marker).length, 2);
    assert.deepEqual(buildFaultCopy(input), result);
    assert.throws(() => { result.anchor.offset = 0; }, TypeError);
  });
}

test('fault rejects identity drift, unknown mode, missing/shifted/ambiguous anchor and nonterminal COMMIT', () => {
  for (const mutate of [
    (x) => { x.expectedSha256 = 'f'.repeat(64); }, (x) => { x.mode = 'arbitrary-sql'; },
    (x) => { x.anchor.offset--; }, (x) => { x.anchor.text = 'missing'; },
    (x) => { x.anchor.offset = -1; }, (x) => { x.anchor.extra = 'ignored'; },
    (x) => { x.mode = 'committed-prefix'; },
    (x) => { x.bytes = Buffer.concat([x.bytes, Buffer.from('SELECT 1;\n')]); x.expectedSha256 = sha(x.bytes); },
    (x) => { x.bytes = Buffer.concat([Buffer.from('COMMIT;\n'), x.bytes]); x.expectedSha256 = sha(x.bytes); x.anchor.offset = x.bytes.lastIndexOf(x.anchor.text); },
    (x) => { x.bytes = Buffer.from('SELECT 1;COMMIT;\n'); x.expectedSha256 = sha(x.bytes); x.anchor.offset = x.bytes.indexOf(x.anchor.text); },
  ]) { const input = faultInput(); mutate(input); assert.throws(() => buildFaultCopy(input)); }
});

test('fault rejects invalid UTF-8, existing marker/delimiter, and unsafe anchor Unicode', () => {
  for (const prefix of [Buffer.from([255]), Buffer.from('-- OVD_REHEARSAL_FAULT_OLD\n'), Buffer.from('-- $ovd_rehearsal_fault$\n')]) {
    const input = faultInput(); input.bytes = Buffer.concat([prefix, input.bytes]); input.expectedSha256 = sha(input.bytes);
    input.anchor.offset = input.bytes.indexOf(input.anchor.text); assert.throws(() => buildFaultCopy(input));
  }
  const input = faultInput(); input.anchor.text = '\uD800'; assert.throws(() => buildFaultCopy(input));
});

test('fault handles CRLF terminal COMMIT and UTF-8 byte offsets without treating JS offsets as bytes', () => {
  const input = faultInput(); input.bytes = Buffer.from('\uFEFF-- λ\r\nBEGIN;\r\nSELECT 1;\r\ncommit;\r\n');
  input.expectedSha256 = sha(input.bytes); input.anchor = { text: 'commit;\r\n', offset: input.bytes.indexOf('commit;') };
  const result = buildFaultCopy(input); assert.equal(result.insertionOffset, input.anchor.offset);
  input.anchor.offset = input.bytes.toString().indexOf('commit;'); assert.throws(() => buildFaultCopy(input));
});
