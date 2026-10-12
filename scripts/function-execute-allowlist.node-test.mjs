// OVD-736 CI check: function EXECUTE allowlist is well-formed, reviewed, and in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST_PATH, PGTAP_PATH, loadAllowlist, migrationFunctionNames, renderPgTap } from './function-execute-allowlist.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowlist = loadAllowlist(root);
const SIG = /^[a-z_][a-z0-9_]*\((?:[a-z0-9_ ."[\]]+(?:, [a-z0-9_ ."[\]]+)*)?\)$/;
const REVIEWED_ANON = new Set([]); // OVD-736: logged-out app needs no RPC. Changing this needs security review.

test('allowlist entries are well-formed with a reason', () => {
  for (const role of ['anon', 'authenticated']) {
    assert.ok(Array.isArray(allowlist[role]), `${role} list missing`);
    const seen = new Set();
    for (const e of allowlist[role]) {
      assert.match(e.signature, SIG, `bad signature ${e.signature}`);
      assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 10, `${role} ${e.signature} needs a reason`);
      assert.ok(!seen.has(e.signature), `duplicate ${role} ${e.signature}`);
      seen.add(e.signature);
    }
  }
});

test('anon allowlist only contains reviewed functions', () => {
  for (const e of allowlist.anon) assert.ok(REVIEWED_ANON.has(e.signature), `unreviewed anon grant ${e.signature}`);
});

test('pending pgTAP test is generated from the allowlist', () => {
  assert.equal(readFileSync(new URL(`../${PGTAP_PATH}`, import.meta.url), 'utf8'), renderPgTap(allowlist),
    `regenerate with: node scripts/function-execute-allowlist.mjs --write`);
});

test('draft migration revokes anon on every listed function and grants none to anon', () => {
  const sql = readFileSync(new URL('../docs/migration-drafts/ovd-736-revoke-anon-execute.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /grant[^;]*\bto\b[^;]*\b(anon|public)\b/i);
  for (const sig of allowlist.revoked_from_anon) {
    assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon;`), `missing revoke for ${sig}`);
  }
});

test('every function name created in migrations is classified', () => {
  const known = new Set([
    ...allowlist.anon, ...allowlist.authenticated,
  ].map((e) => e.signature.split('(')[0]));
  for (const s of allowlist.revoked_from_anon) known.add(s.split('(')[0]);
  const unknownAuth = [...migrationFunctionNames(root)].filter((n) => !known.has(n));
  // Functions not executable by anon/authenticated (service_role/internal) are fine; this only reports
  // drift for names that look like client RPCs so new api_* functions get an explicit decision.
  const drift = unknownAuth.filter((n) => n.startsWith('api_') && !allowlist.service_role_only?.includes(n));
  assert.deepEqual(drift, [], `classify in ${ALLOWLIST_PATH} (authenticated or service_role_only): ${drift.join(', ')}`);
});
