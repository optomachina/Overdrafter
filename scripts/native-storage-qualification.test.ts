import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStorageProbePlan, OPERATOR_BEARER, PROBE_CHECKS, renderStorageProbePlan,
  validateStorageProbeAdmission, type StorageProbeAdmission } from './native-storage-qualification';

const admission = (): StorageProbeAdmission => ({
  owner: 'fixture-owner', probeId: '11111111-1111-4111-8111-111111111111',
  storageOrigin: 'https://synthetic-project.storage.invalid', bucket: 'jarvis-native-outputs',
  sourceSha: 'b'.repeat(40), syntheticOnly: true, existingPrivateBucket: true,
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Storage version probe plan (prints only, contacts nothing)', () => {
  it('builds a plan with every check NOT_RUN and no network access', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const plan = buildStorageProbePlan(admission());
    expect(plan.mode).toBe('plan'); expect(plan.contacts).toBe('NONE'); expect(plan.overall).toBe('NOT_QUALIFIED');
    expect(Object.keys(plan.checks)).toEqual([...PROBE_CHECKS]);
    expect(Object.values(plan.checks).every(status => status === 'NOT_RUN')).toBe(true);
    expect(plan.steps.map(step => step.id)).toEqual([...PROBE_CHECKS]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads the private bucket and empty targets before the first write', () => {
    const plan = buildStorageProbePlan(admission());
    const firstWrite = plan.steps.findIndex(step => step.kind === 'http' && step.requests.some(r => r.method === 'POST'));
    expect(plan.steps.slice(0, firstWrite).map(step => step.kind)).toEqual(['sql', 'sql']);
    expect(plan.steps[0]).toMatchObject({ kind: 'sql', statement: expect.stringContaining('and not public') });
  });
  it('uses only create only POSTs and version specific authenticated GETs on the admitted origin', () => {
    const plan = buildStorageProbePlan(admission());
    const requests = plan.steps.flatMap(step => step.kind === 'http' ? step.requests : []);
    expect(new Set(requests.map(r => r.method))).toEqual(new Set(['GET', 'POST']));
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe(admission().storageOrigin);
      if (request.method === 'POST') expect(request.headers['x-upsert']).toBe('false');
      else expect(request.url).toMatch(/\/storage\/v1\/object\/authenticated\/jarvis-native-outputs\/qualification\/[^?]+\?versionId=/);
    }
    const race = plan.steps.find(step => step.id === 'createOnlyRace');
    expect(race).toMatchObject({ kind: 'http', concurrent: true });
    for (const statement of plan.steps.flatMap(step => step.kind === 'sql' ? [step.statement] : []))
      expect(statement).toMatch(/^select /);
  });
  it('carries only the bearer placeholder, never a credential', () => {
    const plan = buildStorageProbePlan(admission());
    const authorizations = plan.steps.flatMap(step => step.kind === 'http' ? step.requests : [])
      .map(r => r.headers.authorization).filter(value => value !== undefined);
    expect(new Set(authorizations)).toEqual(new Set([OPERATOR_BEARER, 'Bearer deliberately-invalid-synthetic-token']));
    const missing = plan.steps.find(step => step.id === 'missingAuthDenied');
    expect(missing?.kind === 'http' && missing.requests[0].headers.authorization).toBeUndefined();
  });
  it('binds expected digests to the synthetic bytes and names the cleanup set', () => {
    const plan = buildStorageProbePlan(admission());
    expect(plan.syntheticBytes.originalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.syntheticBytes.changedSha256).not.toBe(plan.syntheticBytes.originalSha256);
    expect(plan.steps.find(step => step.id === 'exactVersionHttps')?.expect).toContain(plan.syntheticBytes.originalSha256);
    expect(plan.objects).toEqual([`qualification/${admission().probeId}/first`, `qualification/${admission().probeId}/second`]);
    expect(plan.notCovered).toContain('staleVersionDenied');
    expect(buildStorageProbePlan(admission())).toEqual(plan);
  });
  it('renders a printout that names every step and refuses to qualify', () => {
    const text = renderStorageProbePlan(buildStorageProbePlan(admission()));
    for (const name of PROBE_CHECKS) expect(text).toContain(name);
    expect(text).toContain('contacted nothing');
    expect(text).toContain('Do not set storageVersionIdQualified from this printout.');
    expect(text).not.toMatch(/\b(DELETE|PUT|PATCH)\b/);
  });
  it.each(['http://synthetic-project.storage.invalid', 'https://user:pass@synthetic-project.storage.invalid',
    'https://synthetic-project.storage.invalid/elsewhere', 'https://synthetic-project.storage.invalid/?q=1',
    'https://synthetic-project.storage.invalid/#x', 'not a url'])('rejects unsafe Storage origin %s', storageOrigin => {
    expect(() => validateStorageProbeAdmission({ ...admission(), storageOrigin })).toThrow();
  });
  it.each([{ probeId: 'HEAD' }, { bucket: 'Customer CAD' }, { bucket: '../x' }, { sourceSha: 'HEAD' },
    { owner: 'a b' }, { syntheticOnly: false }, { existingPrivateBucket: false }])('rejects invalid admission %j', patch => {
    expect(() => validateStorageProbeAdmission({ ...admission(), ...patch } as StorageProbeAdmission)).toThrow();
  });
  it('rejects undeclared fields instead of copying possible secrets into the plan', () => {
    expect(() => buildStorageProbePlan({ ...admission(), authorization: 'do-not-copy' } as StorageProbeAdmission))
      .toThrow('Storage probe admission rejected.');
  });
});
