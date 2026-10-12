// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRetryableProviderDispatchDenial, PROVIDER_DISPATCH_DENIAL_CODES } from "./providerDispatchEnvelope";
import {
  createProviderDispatchPermitLocalGuard,
  PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA,
  providerDispatchPermitKey,
} from "./providerDispatchPermitConsumption";

const draft = readFileSync(new URL("../../docs/migration-drafts/ovd-734.sql", import.meta.url), "utf8");

describe("OVD-734 permit consumption SQL contract", () => {
  it("emits only terminal denial codes from the shared vocabulary", () => {
    const emitted = [...draft.matchAll(/provider_dispatch_permit_consumption_denial\('([a-z_]+)'\)/g)].map((match) => match[1]);
    expect(new Set(emitted)).toEqual(new Set([
      "permit_mismatch", "task_inactive", "task_lane_mismatch", "permit_state_missing", "provider_mismatch",
      "scope_mismatch", "permit_revoked", "permit_expired", "permit_not_yet_valid", "provider_kill_switch_engaged",
      "permit_already_consumed",
    ]));
    for (const code of emitted) {
      expect(PROVIDER_DISPATCH_DENIAL_CODES).toContain(code);
      expect(isRetryableProviderDispatchDenial(code as (typeof PROVIDER_DISPATCH_DENIAL_CODES)[number])).toBe(false);
    }
  });

  it("returns exactly the response keys the worker parser requires", () => {
    expect(draft).toContain(`'${PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA}'`);
    expect(draft).toMatch(/'consumed', true,\n\s+'permitId', v_permit\.id,\n\s+'attempt', v_attempt\n/);
    expect(draft).toMatch(/'consumed', false,\n\s+'denial', p_denial\n/);
    expect(draft).toMatch(/'sideEffectStarted', true,\n\s+'permitId', p_permit_id,\n\s+'attempt', p_attempt\n/);
  });

  it("reads the OVD-722 kill switch by its exact table names and fails closed without them", () => {
    expect(draft).toContain("pg_catalog.to_regclass('private.provider_kill_switches') is null");
    expect(draft).toContain("pg_catalog.to_regclass('private.provider_global_kill_switch') is null");
  });
});

describe("in-process permit guard", () => {
  it("remembers a started permit until its expiry, then forgets it", () => {
    const guard = createProviderDispatchPermitLocalGuard();
    const key = providerDispatchPermitKey("permit", "a".repeat(64));
    expect(guard.has(key, 1_000)).toBe(false);
    guard.add(key, 2_000, 1_000);
    expect(guard.has(key, 1_999)).toBe(true);
    expect(guard.has(providerDispatchPermitKey("permit", "b".repeat(64)), 1_999)).toBe(false);
    expect(guard.has(key, 2_000)).toBe(false);
  });
});
