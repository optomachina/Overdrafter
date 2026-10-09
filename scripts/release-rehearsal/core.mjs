import { createHash } from 'node:crypto';

export const MANIFEST_SCHEMA = 'overdrafter.release-rehearsal-manifest.v1';
export const PLAN_SCHEMA = 'overdrafter.release-rehearsal-plan.v1';
export const CATALOG_SCHEMA = 'overdrafter.release-rehearsal-catalog.v1';
export const CATALOG_COVERAGE = Object.freeze(['schemas', 'roles', 'relations', 'functions', 'policies', 'defaultPrivileges']);
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]{14}$/;
const lexical = (a, b) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

// Plain JSON only: no getters, prototypes, undefined, sparse arrays or nonfinite
// numbers. Canonicalize object keys, never semantic array order or numeric OIDs.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value) && !Object.is(value, -0), 'Invalid JSON number.');
    return JSON.stringify(value);
  }
  requireThat(value !== null && typeof value === 'object', 'Expected plain JSON value.');
  const keys = Reflect.ownKeys(value);
  requireThat(keys.every((key) => typeof key === 'string'), 'Symbol JSON property.');
  if (Array.isArray(value)) {
    requireThat(keys.length === value.length + 1 && value.every((_, i) => Object.hasOwn(value, i)), 'Sparse or decorated array.');
    return '[' + Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      requireThat(descriptor && Object.hasOwn(descriptor, 'value'), 'JSON accessor.');
      return canonical(descriptor.value);
    }).join(',') + ']';
  }
  requireThat(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Expected plain JSON object.');
  return '{' + keys.sort(lexical).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Hidden property or JSON accessor.');
    return JSON.stringify(key) + ':' + canonical(descriptor.value);
  }).join(',') + '}';
}

function frozenJson(value) {
  const copy = JSON.parse(canonical(value));
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

function shape(value, keys, label) {
  requireThat(value && !Array.isArray(value) && typeof value === 'object', `${label}: expected object.`);
  requireThat(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), `${label}: unexpected or missing fields.`);
}

function relativePath(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Invalid relative source path.');
}

function entry(value, migration) {
  shape(value, migration ? ['path', 'version', 'sha256'] : ['path', 'sha256'], 'Source entry');
  relativePath(value.path);
  requireThat(typeof value.sha256 === 'string' && SHA256.test(value.sha256), 'Invalid source SHA-256.');
  if (migration) {
    requireThat(typeof value.version === 'string' && VERSION.test(value.version), 'Invalid migration version.');
    requireThat(new RegExp(`^supabase/migrations/${value.version}_[A-Za-z0-9_-]+\\.sql$`).test(value.path), 'Migration path/version mismatch.');
  }
}

function makePlan(manifest, baselineVersions) {
  shape(manifest, ['schema', 'sourceCommit', 'migrations', 'inputs'], 'Manifest');
  requireThat(manifest.schema === MANIFEST_SCHEMA && typeof manifest.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(manifest.sourceCommit), 'Unknown manifest schema or source commit.');
  requireThat(Array.isArray(manifest.migrations) && manifest.migrations.length > 0 && Array.isArray(manifest.inputs), 'Missing migration/input arrays.');
  const byVersion = new Map();
  let previous = '';
  for (const item of manifest.migrations) {
    entry(item, true);
    requireThat(item.version > previous, 'Migration order must be strictly increasing.');
    previous = item.version;
    byVersion.set(item.version, item);
  }
  const inputs = new Map();
  previous = '';
  for (const item of manifest.inputs) {
    entry(item, false);
    requireThat(item.path > previous, 'Input paths must be unique and strictly ordered.');
    previous = item.path;
    inputs.set(item.path, item.sha256);
  }
  for (const item of manifest.migrations) requireThat(inputs.get(item.path) === item.sha256, 'Migration absent from closed inputs or hash mismatch.');
  // An extra migration in inputs must not evade the canonical candidate list.
  const migrationPaths = new Set(manifest.migrations.map((item) => item.path));
  for (const input of manifest.inputs) {
    requireThat(!input.path.startsWith('supabase/migrations/') || migrationPaths.has(input.path), 'Unlisted migration in closed inputs.');
  }
  requireThat(Array.isArray(baselineVersions), 'Baseline must be a synthetic version array.');
  previous = '';
  for (const version of baselineVersions) {
    requireThat(typeof version === 'string' && byVersion.has(version) && version > previous, 'Baseline versions must be known, unique and in candidate order.');
    previous = version;
  }
  const selected = new Set(baselineVersions);
  const contents = {
    schema: PLAN_SCHEMA, qualification: 'synthetic-only', sourceCommit: manifest.sourceCommit,
    manifestSha256: digest(canonical(manifest)), inputs: manifest.inputs,
    canonical: manifest.migrations,
    baseline: manifest.migrations.filter((item) => selected.has(item.version)),
    absent: manifest.migrations.filter((item) => !selected.has(item.version)),
  };
  return frozenJson({ ...contents, planSha256: digest(canonical(contents)) });
}

/** Build an exact closed-source synthetic plan; does not read disk or run tools. */
export function buildPlan({ manifest, sourceFiles, baselineVersions }) {
  const safeManifest = frozenJson(manifest);
  const plan = makePlan(safeManifest, baselineVersions);
  requireThat(sourceFiles instanceof Map && sourceFiles.size === plan.inputs.length, 'Source file set is not closed.');
  for (const input of plan.inputs) {
    const bytes = sourceFiles.get(input.path);
    requireThat(Buffer.isBuffer(bytes) && digest(bytes) === input.sha256, `Missing or drifted source bytes: ${input.path}`);
  }
  return plan;
}

function validatePlan(plan) {
  const copy = frozenJson(plan);
  shape(copy, ['schema', 'qualification', 'sourceCommit', 'manifestSha256', 'inputs', 'canonical', 'baseline', 'absent', 'planSha256'], 'Plan');
  requireThat(Array.isArray(copy.baseline), 'Invalid plan baseline.');
  const reconstructed = makePlan({ schema: MANIFEST_SCHEMA, sourceCommit: copy.sourceCommit, migrations: copy.canonical, inputs: copy.inputs }, copy.baseline.map((item) => item.version));
  requireThat(canonical(copy) === canonical(reconstructed), 'Plan identity or ordering drift.');
  return copy;
}

function ledgerRows(value, label) {
  const rows = frozenJson(value);
  requireThat(Array.isArray(rows), `${label}: expected observed ledger array.`);
  const seen = new Set();
  for (const row of rows) {
    shape(row, ['version', 'name', 'statements'], label);
    requireThat(typeof row.version === 'string' && VERSION.test(row.version) && !seen.has(row.version), `${label}: invalid or duplicate version.`);
    requireThat(row.name === null || typeof row.name === 'string', `${label}: invalid observed name.`);
    requireThat(row.statements === null || (Array.isArray(row.statements) && row.statements.every((statement) => typeof statement === 'string')), `${label}: statements must be actual string arrays or null.`);
    seen.add(row.version);
  }
  return rows;
}

/** Classify ledger identities, never authorize retry or infer catalog rollback.
 * name/statements are actual CLI observations, not reconstructed from file hashes.
 */
export function classifyLedger({ plan, baselineLedger, currentLedger }) {
  const checked = validatePlan(plan);
  const baseline = ledgerRows(baselineLedger, 'Baseline ledger');
  const current = ledgerRows(currentLedger, 'Current ledger');
  const expectedBaseline = new Set(checked.baseline.map((item) => item.version));
  requireThat(baseline.length === expectedBaseline.size && baseline.every((row) => expectedBaseline.has(row.version)), 'Baseline ledger does not match synthetic baseline identities.');
  const currentByVersion = new Map(current.map((row) => [row.version, row]));
  const known = new Set(checked.canonical.map((item) => item.version));
  const reasons = [];
  for (const row of current) if (!known.has(row.version)) reasons.push(`Unknown version: ${row.version}`);
  for (const row of baseline) {
    const observed = currentByVersion.get(row.version);
    if (!observed) reasons.push(`Missing baseline version: ${row.version}`);
    else if (canonical(row) !== canonical(observed)) reasons.push(`Baseline representation drift: ${row.version}`);
  }
  const completedVersions = [];
  let gap = false;
  for (const item of checked.absent) {
    if (!currentByVersion.has(item.version)) gap = true;
    else {
      completedVersions.push(item.version);
      if (gap) reasons.push(`Non-prefix applied version: ${item.version}`);
    }
  }
  let status = 'baseline';
  if (completedVersions.length) status = 'completed-prefix';
  if (completedVersions.length === checked.absent.length) status = 'final';
  if (reasons.length) status = 'drift';
  const orderedRows = [...current].sort((a, b) => lexical(a.version, b.version));
  return frozenJson({
    status, reasons, completedVersions,
    pendingVersions: checked.absent.filter((item) => !currentByVersion.has(item.version)).map((item) => item.version),
    planSha256: checked.planSha256, ledgerSha256: digest(canonical(orderedRows)),
    statementEvidence: 'observed-only', catalogEvidence: 'not-compared',
    qualification: 'synthetic-only', safeToResume: false,
  });
}

const CATALOG_FIELDS = Object.freeze({
  schema: ['owner', 'acl'], role: ['attributes', 'memberships'],
  relation: ['owner', 'acl', 'rls', 'forceRls', 'definition'],
  function: ['owner', 'acl', 'definition'],
  policy: ['relation', 'roles', 'command', 'permissive', 'using', 'withCheck'],
  defaultPrivilege: ['owner', 'schema', 'objectType', 'acl'],
});
const ROLE_FLAGS = ['superuser', 'inherit', 'createRole', 'createDb', 'canLogin', 'replication', 'bypassRls'];
const nonempty = (value) => typeof value === 'string' && value.length > 0;

function validateAcl(acl) {
  requireThat(acl === null || Array.isArray(acl), 'Invalid ACL evidence.');
  if (acl === null) return;
  for (const grant of acl) {
    requireThat(grant && ['grantor', 'grantee', 'privilege'].every((field) => nonempty(grant[field])) &&
      typeof grant.grantable === 'boolean', 'Incomplete named ACL grant.');
  }
}

function validateRole(record) {
  const attrs = record.attributes;
  requireThat(attrs && typeof attrs === 'object' && !Array.isArray(attrs) &&
    ROLE_FLAGS.every((key) => typeof attrs[key] === 'boolean') &&
    Number.isSafeInteger(attrs.connectionLimit) && attrs.connectionLimit >= -1 &&
    (attrs.validUntil === null || typeof attrs.validUntil === 'string') && Array.isArray(record.memberships), 'Incomplete role attributes or memberships.');
  for (const membership of record.memberships) {
    requireThat(membership && nonempty(membership.role) && nonempty(membership.grantor) &&
      ['admin', 'inherit', 'set'].every((key) => typeof membership[key] === 'boolean'), 'Incomplete named role membership.');
  }
}

function validateCatalogRecord(record) {
  requireThat(record && !Array.isArray(record) && Object.hasOwn(CATALOG_FIELDS, record.kind) && nonempty(record.identity), 'Unknown catalog kind or unnamed identity.');
  const fields = CATALOG_FIELDS[record.kind];
  requireThat(fields.every((key) => Object.hasOwn(record, key)), 'Incomplete semantic catalog record.');
  for (const field of ['owner', 'relation', 'command', 'objectType']) {
    if (fields.includes(field)) requireThat(nonempty(record[field]), `Missing named ${field}.`);
  }
  if (fields.includes('acl')) validateAcl(record.acl);
  if (fields.includes('definition')) requireThat(nonempty(record.definition) ||
    (record.definition && !Array.isArray(record.definition) && typeof record.definition === 'object' && Object.keys(record.definition).length > 0), 'Missing semantic definition.');
  if (record.kind === 'relation') requireThat(typeof record.rls === 'boolean' && typeof record.forceRls === 'boolean', 'Invalid RLS evidence.');
  if (record.kind === 'role') validateRole(record);
  if (record.kind === 'policy') requireThat(Array.isArray(record.roles) && record.roles.every(nonempty) && typeof record.permissive === 'boolean' &&
    (record.using === null || typeof record.using === 'string') && (record.withCheck === null || typeof record.withCheck === 'string'), 'Invalid policy evidence.');
  if (record.kind === 'defaultPrivilege') requireThat(record.schema === null || nonempty(record.schema), 'Invalid default privilege schema.');
}

function catalog(value) {
  const copy = frozenJson(value);
  shape(copy, ['schema', 'coverage', 'records'], 'Catalog');
  requireThat(copy.schema === CATALOG_SCHEMA && Array.isArray(copy.coverage) &&
    canonical([...copy.coverage].sort(lexical)) === canonical([...CATALOG_COVERAGE].sort(lexical)), 'Unknown or incomplete catalog coverage.');
  requireThat(Array.isArray(copy.records) && copy.records.length > 0, 'Empty catalog evidence.');
  const records = new Map();
  for (const record of copy.records) {
    validateCatalogRecord(record);
    const key = JSON.stringify([record.kind, record.identity]);
    requireThat(!records.has(key), 'Duplicate catalog identity.');
    records.set(key, record);
  }
  return records;
}

/** Compare complete named evidence supplied by an extractor. Coverage is an
 * extractor assertion, not independent proof that its SQL selected every object.
 */
export function compareCatalogs(left, right) {
  const a = catalog(left); const b = catalog(right);
  const missing = []; const extra = []; const changed = [];
  for (const key of [...a.keys()].sort(lexical)) {
    if (!b.has(key)) missing.push(JSON.parse(key));
    else if (canonical(a.get(key)) !== canonical(b.get(key))) changed.push(JSON.parse(key));
  }
  for (const key of [...b.keys()].sort(lexical)) if (!a.has(key)) extra.push(JSON.parse(key));
  const hash = (map) => digest(canonical([...map.entries()].sort(([x], [y]) => lexical(x, y)).map(([, record]) => record)));
  return frozenJson({ equal: missing.length + extra.length + changed.length === 0, missing, extra, changed,
    leftSha256: hash(a), rightSha256: hash(b), qualification: 'supplied-records-only', coverage: CATALOG_COVERAGE });
}

/** Produce a separately hashed disposable copy. Placement is not proof that an
 * anchor is top-level SQL or that the real CLI reaches a transaction boundary.
 */
export function buildFaultCopy({ bytes, expectedSha256, mode, anchor }) {
  requireThat(Buffer.isBuffer(bytes) && typeof expectedSha256 === 'string' && SHA256.test(expectedSha256) && digest(bytes) === expectedSha256, 'Fault source identity mismatch.');
  requireThat(['committed-prefix', 'in-file', 'commit-to-ledger'].includes(mode), 'Unknown fault mode.');
  anchor = frozenJson(anchor);
  shape(anchor, ['text', 'offset'], 'Fault anchor');
  requireThat(nonempty(anchor.text) && Number.isSafeInteger(anchor.offset) && anchor.offset >= 0, 'Invalid fault anchor.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  requireThat(Buffer.from(text, 'utf8').equals(bytes) && Buffer.from(anchor.text, 'utf8').toString('utf8') === anchor.text, 'Fault source/anchor must be exact UTF-8.');
  const needle = Buffer.from(anchor.text, 'utf8');
  const first = bytes.indexOf(needle);
  requireThat(first === anchor.offset && first >= 0 && bytes.indexOf(needle, first + 1) === -1, 'Missing, shifted or ambiguous fault anchor.');
  if (mode === 'committed-prefix') requireThat(first === 0, 'Committed-prefix failure must precede the next file.');
  if (mode !== 'committed-prefix') {
    requireThat(/^(?:\r?\n)?[ \t]*commit;[ \t]*(?:\r?\n|$)$/i.test(anchor.text) &&
      first + needle.length === bytes.length && (first === 0 || bytes[first - 1] === 10 || needle[0] === 10),
    'Transaction boundary requires an exact standalone terminal COMMIT anchor.');
  }
  const marker = 'OVD_REHEARSAL_FAULT_' + mode.replaceAll('-', '_').toUpperCase();
  const tag = '$ovd_rehearsal_fault$';
  requireThat(!text.includes('OVD_REHEARSAL_FAULT_') && !text.includes(tag), 'Source already contains fault marker or delimiter.');
  const insertedSql = `\nDO ${tag} BEGIN RAISE EXCEPTION '${marker}'; END ${tag};\n`;
  let insertionOffset = first + needle.length;
  if (mode === 'committed-prefix') insertionOffset = 0;
  if (mode === 'in-file') insertionOffset = first;
  const changed = Buffer.concat([bytes.subarray(0, insertionOffset), Buffer.from(insertedSql), bytes.subarray(insertionOffset)]);
  return frozenJson({ schema: 'overdrafter.release-rehearsal-fault.v1', mode,
    originalSha256: expectedSha256, faultSha256: digest(changed), bytesBase64: changed.toString('base64'), byteLength: changed.length,
    anchor, insertionOffset, insertedSql, marker, qualification: 'placement-only', runtimeBoundary: 'not-run' });
}
