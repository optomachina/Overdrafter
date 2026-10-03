import { describe, expect, it, vi } from 'vitest';
import { qualifyNativeStorage, validateStorageFixtureAdmission, type StorageFixtureAdmission } from './native-storage-qualification';
const admission = (): StorageFixtureAdmission => ({
  owner: 'fixture-owner', fixtureId: '11111111-1111-4111-8111-111111111111',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  storageOrigin: 'https://127.0.0.1:5443', databaseOrigin: 'postgresql://127.0.0.1:5432/',
  bucket: 'jarvis-fixture-synthetic', imageDigest: 'sha256:' + 'a'.repeat(64), sourceSha: 'b'.repeat(40),
  containers: ['c'.repeat(64), 'd'.repeat(64)], network: 'e'.repeat(64),
  syntheticOnly: true, exclusiveInternalNetwork: true, existingPrivateBucket: true,
});
describe('Storage qualification admission guardrails (inert SOURCE only)', () => {
  it('defaults to plan without reading supplied capabilities', async () => {
    const options = { admission: admission(), get capabilities(): never { throw Error('Must not inspect authorization'); } };
    const receipt = await qualifyNativeStorage(options);
    expect(receipt.mode).toBe('plan');
    expect(Object.values(receipt.checks).every(status => status === 'NOT_RUN')).toBe(true);
    expect(receipt.cleanup).toBe('NOT_REQUIRED');
    expect(receipt.overall).toBe('NOT_QUALIFIED');
    expect(receipt.attemptedObjects).toEqual([]);
  });
  it.each(['https://example.supabase.co:443', 'http://127.0.0.1:54321', 'https://localhost:54321',
    'https://127.0.0.1:54321/elsewhere', 'https://user:pass@127.0.0.1:54321',
    'https://127.0.0.1:54321/?q=1', 'https://127.0.0.1:54321/#x'])('rejects unsafe Storage destination %s', storageOrigin => {
    expect(() => validateStorageFixtureAdmission({ ...admission(), storageOrigin })).toThrow();
  });
  it.each(['postgresql://db.example.com:5432/', 'postgresql://u:p@127.0.0.1:5432/', 'https://127.0.0.1:5432/'])('rejects unsafe SQL attestation %s', databaseOrigin => {
    expect(() => validateStorageFixtureAdmission({ ...admission(), databaseOrigin })).toThrow();
  });
  it.each([{ expiresAt: 'invalid' }, { expiresAt: new Date(0).toISOString() },
    { expiresAt: new Date(Date.now() + 3600000).toISOString() }, { containers: ['a', 'b', 'c'] },
    { containers: ['c'.repeat(64), 'c'.repeat(64)] }, { imageDigest: 'latest' },
    { bucket: 'customer-cad' }, { existingPrivateBucket: false }, { exclusiveInternalNetwork: false },
    { syntheticOnly: false }, { sourceSha: 'HEAD' }])('rejects invalid admission %j', patch => {
    expect(() => validateStorageFixtureAdmission({ ...admission(), ...patch } as StorageFixtureAdmission)).toThrow();
  });
  it('rejects undeclared admission fields instead of copying possible secrets into receipts', async () => {
    await expect(qualifyNativeStorage({ admission: { ...admission(), authorization: 'do-not-copy' } as StorageFixtureAdmission })).rejects.toThrow();
  });
  it('requires capability on explicit execute and never prints authorization', async () => {
    await expect(qualifyNativeStorage({ admission: admission(), execute: true })).rejects.toThrow('Fixture qualification check failed.');
  });
  it('fails before HTTPS or mutations if private-bucket SQL fails, redacting error detail', async () => {
    const query = vi.fn().mockRejectedValue(Error('secret credential must not be retained'));
    const receipt = await qualifyNativeStorage({ admission: admission(), execute: true,
      capabilities: { sql: { query, transaction: vi.fn() }, authorization: 'Bearer inert-unusable-string', persistCheckpoint: vi.fn() } });
    expect(receipt.checks.privateBucket).toBe('FAIL');
    expect(receipt.checks.createOnlyRace).toBe('NOT_RUN');
    expect(receipt.attemptedObjects).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain('secret');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('refuses any POST if durable checkpoint acknowledgement fails', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ id: admission().bucket }]).mockResolvedValueOnce([]);
    const persistCheckpoint = vi.fn().mockRejectedValue(Error('disk full'));
    const receipt = await qualifyNativeStorage({ admission: admission(), execute: true,
      capabilities: { sql: { query, transaction: vi.fn() }, authorization: 'Bearer inert-unusable-string', persistCheckpoint } });
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(receipt.checks.createOnlyRace).toBe('FAIL');
    expect(receipt.attemptedObjects).toHaveLength(1);
    expect(receipt.cleanup).toBe('OWNER_CLEANUP_REQUIRED');
  });
  it('bounds a noncooperative SQL capability and clears owned timers', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise<readonly Record<string, unknown>[]>(() => {}));
      const pending = qualifyNativeStorage({ admission: admission(), execute: true,
        capabilities: { sql: { query, transaction: vi.fn() }, authorization: 'Bearer inert-unusable-string', persistCheckpoint: vi.fn() } });
      await vi.advanceTimersByTimeAsync(10001);
      const receipt = await pending;
      expect(receipt.checks.privateBucket).toBe('FAIL');
      expect(receipt.attemptedObjects).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not checkpoint or POST when any intended target already exists', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ id: admission().bucket }]).mockResolvedValueOnce([{ id: 'collision' }]);
    const persistCheckpoint = vi.fn();
    const receipt = await qualifyNativeStorage({ admission: admission(), execute: true,
      capabilities: { sql: { query, transaction: vi.fn() }, authorization: 'Bearer inert-unusable-string', persistCheckpoint } });
    expect(receipt.checks.emptyOwnedTarget).toBe('FAIL');
    expect(persistCheckpoint).not.toHaveBeenCalled();
    expect(receipt.attemptedObjects).toEqual([]);
  });
  it('bounds an unacknowledged checkpoint without starting POST', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValueOnce([{ id: admission().bucket }]).mockResolvedValueOnce([]);
      const pending = qualifyNativeStorage({ admission: admission(), execute: true,
        capabilities: { sql: { query, transaction: vi.fn() }, authorization: 'Bearer inert-unusable-string',
          persistCheckpoint: () => new Promise<void>(() => {}) } });
      await vi.advanceTimersByTimeAsync(10001);
      expect((await pending).checks.createOnlyRace).toBe('FAIL');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

});
