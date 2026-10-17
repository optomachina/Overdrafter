/** Storage version probe PLAN for the native first loop. It prints the exact SQL
 * reads and HTTP requests an operator later runs by hand against hosted Storage.
 * Plan only: no network, SQL, environment reads, credentials or object writes. */
// @ts-expect-error Shared JavaScript helper has no declaration file in this TS-only project.
import { isEntryPoint } from "./lib/entry-point.mjs";
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type StorageProbeAdmission = Readonly<{
  owner: string; probeId: string; storageOrigin: string; bucket: string; sourceSha: string;
  syntheticOnly: true; existingPrivateBucket: true;
}>;
type SqlStep = Readonly<{ id: string; kind: 'sql'; statement: string; expect: string }>;
type HttpRequest = Readonly<{ method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>>; body?: string }>;
type HttpStep = Readonly<{ id: string; kind: 'http'; requests: readonly HttpRequest[]; concurrent: boolean; expect: string }>;
export type StorageProbeStep = SqlStep | HttpStep;
export type StorageProbePlan = Readonly<{
  schema: 'overdrafter.native-storage-probe-plan.v1'; mode: 'plan'; contacts: 'NONE';
  admission: StorageProbeAdmission; objects: readonly string[];
  syntheticBytes: Readonly<{ original: string; originalSha256: string; changed: string; changedSha256: string }>;
  steps: readonly StorageProbeStep[]; checks: Readonly<Record<string, 'NOT_RUN'>>;
  notCovered: readonly string[]; cleanup: string; overall: 'NOT_QUALIFIED';
}>;

/** Placeholder only. The operator types the bearer at run time; it never enters this plan or a receipt. */
export const OPERATOR_BEARER = '<operator bearer, typed at run time, never stored>';
export const PROBE_CHECKS = ['privateBucket', 'emptyOwnedTarget', 'createOnlyRace', 'metadataReference',
  'exactVersionHttps', 'missingAuthDenied', 'wrongAuthDenied', 'wrongVersionDenied',
  'crossObjectVersionDenied', 'changedByteReplayPreservesOriginal'] as const;
const NOT_COVERED = ['staleVersionDenied', 'generationChangesDuringRead', 'responseLossReplay',
  'redirectCompressionPartialTimeout', 'productDriverExactRead', 'productDriverCreateConflict', 'artifactRouteHttps'];
const keys = new Set(['owner', 'probeId', 'storageOrigin', 'bucket', 'sourceSha', 'syntheticOnly', 'existingPrivateBucket']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assert(value: unknown): asserts value { if (!value) throw new Error('Storage probe admission rejected.'); }
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

export function validateStorageProbeAdmission(a: StorageProbeAdmission) {
  assert(a !== null && typeof a === 'object' && !Array.isArray(a));
  // Unknown fields are refused so nothing secret is copied into a printed plan.
  assert(Object.keys(a).length === keys.size && Object.keys(a).every(key => keys.has(key)));
  assert(typeof a.storageOrigin === 'string');
  const origin = new URL(a.storageOrigin);
  assert(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/'
    && !origin.search && !origin.hash && a.storageOrigin.replace(/\/$/, '') === origin.origin);
  assert(typeof a.owner === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(a.owner));
  assert(typeof a.probeId === 'string' && uuid.test(a.probeId));
  assert(typeof a.bucket === 'string' && /^[a-z0-9][a-z0-9_-]{2,62}$/.test(a.bucket));
  assert(typeof a.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(a.sourceSha));
  assert(a.syntheticOnly === true && a.existingPrivateBucket === true);
}

export function buildStorageProbePlan(input: StorageProbeAdmission): StorageProbePlan {
  const a = structuredClone(input);
  validateStorageProbeAdmission(a);
  const origin = new URL(a.storageOrigin).origin;
  const first = `qualification/${a.probeId}/first`, second = `qualification/${a.probeId}/second`;
  // Deterministic from the admission so a printed plan is reproducible; never the result of a request.
  const h = sha256(`wrong-version ${a.probeId}`);
  const wrongVersion = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const original = `JARVIS synthetic Storage qualification ${a.probeId}\n`;
  const changed = 'SYNTHETIC CHANGED REPLAY MUST NOT REPLACE\n';
  const objectUrl = (name: string) => `${origin}/storage/v1/object/${a.bucket}/${name}`;
  const readUrl = (name: string, version: string) =>
    `${origin}/storage/v1/object/authenticated/${a.bucket}/${name}?versionId=${version}`;
  const post = (name: string, body: string): HttpRequest => ({ method: 'POST', url: objectUrl(name), body,
    headers: { authorization: OPERATOR_BEARER, 'content-type': 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'no-store' } });
  const get = (name: string, version: string, authorization: string | null = OPERATOR_BEARER): HttpRequest => ({
    method: 'GET', url: readUrl(name, version),
    headers: authorization === null ? { 'cache-control': 'no-store' } : { authorization, 'cache-control': 'no-store' } });
  const reference = (name: string) => `select o.id, o.version, o.updated_at::text from storage.objects o
  join storage.buckets b on b.id = o.bucket_id and not b.public
  where o.bucket_id = ${literal(a.bucket)} and o.name = ${literal(name)};`;
  const denied = 'an explicit 400, 401, 403 or 404; a 200, redirect, 5xx or timeout fails the check';
  const steps: StorageProbeStep[] = [
    { id: 'privateBucket', kind: 'sql', statement: `select id from storage.buckets where id = ${literal(a.bucket)} and not public;`,
      expect: 'exactly one row; zero rows stops the probe before any write' },
    { id: 'emptyOwnedTarget', kind: 'sql',
      statement: `select id from storage.objects where bucket_id = ${literal(a.bucket)} and name in (${literal(first)}, ${literal(second)});`,
      expect: 'zero rows; any row stops the probe and nothing is overwritten or removed' },
    { id: 'createOnlyRace', kind: 'http', concurrent: true, requests: [post(first, original), post(first, original)],
      expect: 'exactly one 2xx and one 400 or 409 whose JSON code is ResourceAlreadyExists' },
    { id: 'metadataReference', kind: 'sql', statement: reference(first),
      expect: 'exactly one row whose version is a UUID; record it as V1' },
    { id: 'exactVersionHttps', kind: 'http', concurrent: false, requests: [get(first, '<V1>')],
      expect: `200 and body SHA-256 ${sha256(original)}` },
    { id: 'missingAuthDenied', kind: 'http', concurrent: false, requests: [get(first, '<V1>', null)], expect: denied },
    { id: 'wrongAuthDenied', kind: 'http', concurrent: false,
      requests: [get(first, '<V1>', 'Bearer deliberately-invalid-synthetic-token')], expect: denied },
    { id: 'wrongVersionDenied', kind: 'http', concurrent: false, requests: [get(first, wrongVersion)], expect: denied },
    { id: 'crossObjectVersionDenied', kind: 'http', concurrent: false, requests: [post(second, original), get(first, '<V2>')],
      expect: `the POST returns 2xx; then run the metadataReference read for ${second} and record its version as V2 (it must differ from V1); the GET of ${first} with V2 returns ${denied}` },
    { id: 'changedByteReplayPreservesOriginal', kind: 'http', concurrent: false, requests: [post(first, changed), get(first, '<V1>')],
      expect: `the POST returns 400 or 409 with ResourceAlreadyExists; the metadataReference read for ${first} returns the identical row; the GET returns 200 with SHA-256 ${sha256(original)}` },
  ];
  return Object.freeze({
    schema: 'overdrafter.native-storage-probe-plan.v1', mode: 'plan', contacts: 'NONE', admission: a,
    objects: [first, second],
    syntheticBytes: { original, originalSha256: sha256(original), changed, changedSha256: sha256(changed) },
    steps, checks: Object.fromEntries(PROBE_CHECKS.map(name => [name, 'NOT_RUN' as const])),
    notCovered: NOT_COVERED,
    cleanup: `After recording results, remove only ${first} and ${second} from ${a.bucket} through the owner's established lifecycle. This plan performs no delete, update or bucket change.`,
    overall: 'NOT_QUALIFIED',
  });
}

export function renderStorageProbePlan(plan: StorageProbePlan): string {
  const lines = [`Storage version probe plan ${plan.admission.probeId} for ${plan.admission.storageOrigin} bucket ${plan.admission.bucket}`,
    `Source ${plan.admission.sourceSha}. This printout contacted nothing. Stop at the first failed step.`, ''];
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.id} (${step.kind})`);
    if (step.kind === 'sql') lines.push(`   ${step.statement.replaceAll('\n', '\n   ')}`);
    else {
      if (step.concurrent) lines.push('   send these requests at the same time:');
      for (const request of step.requests) {
        lines.push(`   ${request.method} ${request.url}`);
        for (const [name, value] of Object.entries(request.headers)) lines.push(`     ${name}: ${value}`);
        if (request.body !== undefined) lines.push(`     body: ${JSON.stringify(request.body)}`);
      }
    }
    lines.push(`   expect: ${step.expect}`, '');
  });
  lines.push(`Not covered by this plan: ${plan.notCovered.join(', ')}.`, `Cleanup: ${plan.cleanup}`,
    'Result: NOT_QUALIFIED until every step passes and the uncovered cases are closed. Do not set storageVersionIdQualified from this printout.');
  return lines.join('\n');
}

// The admission JSON arrives on stdin, so the script opens no file path of its own.
if (isEntryPoint(import.meta.url)) {
  const plan = buildStorageProbePlan(JSON.parse(readFileSync(0, 'utf8')) as StorageProbeAdmission);
  console.log(process.argv.includes('--json') ? JSON.stringify(plan, null, 2) : renderStorageProbePlan(plan));
}
