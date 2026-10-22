// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorQuoteAdapterOutput } from "../types.js";
import { assertProviderKillSwitchDisengaged, PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerSettings.js";
import {
  engageFixtureHealBrake, releaseFixtureHealBrake, FixtureHealBrakeConflictError,
  parseKillSwitchListing, supabaseFixtureHealBrakePort, SERVICE_KILL_SWITCH_LIST_SCHEMA,
  SERVICE_LIST_KILL_SWITCHES_RPC, SERVICE_SET_PROVIDER_KILL_SWITCH_RPC,
  type FixtureHealBrakePort, type KillSwitchRow,
} from "./brake.js";
import { createCertificationPermitKillSwitchReader, decideCertificationPermit } from "./certificationPermit.js";
import { createSupplierPauseSwitch, isInternalTestQuote, type FixtureHealPage } from "./pause.js";
import { createFixtureSanityGate, type FixtureSanityContext } from "./gate.js";

const provider = "fictiv" as const;
const row = (overrides: Partial<KillSwitchRow> = {}): KillSwitchRow => ({
  engaged: false, version: 3, changedBy: "cli:service_role", operator: "fixture-heal", ...overrides,
});
function fake(initial: KillSwitchRow | null = row()) {
  const state = { provider: initial, global: row() as KillSwitchRow | null, beforeSet: () => {} };
  const listKillSwitches = vi.fn(async (): Promise<unknown> => ({
    schema: SERVICE_KILL_SWITCH_LIST_SCHEMA,
    global: state.global && { ...state.global },
    providers: state.provider ? [{ provider, ...state.provider }] : [],
  }));
  // Model OVD-771: engage always wins; release alone requires matching CAS.
  const setProviderKillSwitch = vi.fn(async (args: Parameters<FixtureHealBrakePort["setProviderKillSwitch"]>[0]): Promise<unknown> => {
    state.beforeSet();
    const current = state.provider ?? row({ version: 0 });
    if (!args.engaged && args.expectedVersion !== current.version) throw new FixtureHealBrakeConflictError();
    state.provider = row({ engaged: args.engaged, version: current.version + 1, operator: args.operator });
    return { provider, ...state.provider };
  });
  const base = vi.fn(async () => ({ schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider,
    engaged: state.provider?.engaged ?? true, globalEngaged: state.global?.engaged ?? true }));
  return { state, port: { listKillSwitches, setProviderKillSwitch }, base };
}
const engageInput = { provider, codes: ["missing_price"], runId: "synthetic-run" };
const releaseInput = { provider, expectedVersion: 4, via: "reverify" as const, evidenceRef: "synthetic-cert" };
const pauseInput = { ...engageInput, vendorQuoteResultId: "synthetic-result", nowMs: 0 };
const permitReader = (f: ReturnType<typeof fake>, internalTestQuote = true) => createCertificationPermitKillSwitchReader({
  base: f.base, port: f.port, provider, mode: "on", internalTestQuote,
});
const assertReader = (reader: ReturnType<typeof permitReader>) => assertProviderKillSwitchDisengaged({ reader, provider, checkpoint: "claim" });

it("engage_records_operator_fixture_heal_reason_ge_10", async () => {
  const f = fake();
  expect(await engageFixtureHealBrake(f.port, engageInput)).toEqual({ kind: "engaged", version: 4, owned: true });
  const args = f.port.setProviderKillSwitch.mock.calls[0][0];
  expect(args).toMatchObject({ operator: "fixture-heal", engaged: true });
  expect(args).not.toHaveProperty("expectedVersion");
  expect(args.reason).toMatch(/^fixture-heal sanity /);
  expect(args.reason.trim().length).toBeGreaterThanOrEqual(10);
});
it("idempotent_reengage_makes_no_write", async () => {
  const f = fake();
  await engageFixtureHealBrake(f.port, engageInput);
  expect(await engageFixtureHealBrake(f.port, engageInput)).toMatchObject({ kind: "already_engaged", ownedByFixtureHeal: true });
  expect(f.port.setProviderKillSwitch).toHaveBeenCalledTimes(1);
});
it("engage_never_overwrites_a_human_engagement", async () => {
  for (const owner of [{ changedBy: "00000000-0000-0000-0000-000000000001", operator: null }, { changedBy: "cli:service_role", operator: "blaine" }]) {
    const f = fake(row({ engaged: true, ...owner }));
    expect(await engageFixtureHealBrake(f.port, engageInput)).toMatchObject({ kind: "already_engaged", ownedByFixtureHeal: false });
    expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
  }
});
it("engage_missing_provider_row_is_not_created", async () => {
  const f = fake(null);
  expect(await engageFixtureHealBrake(f.port, engageInput)).toEqual({ kind: "already_engaged", version: null,
    ownedByFixtureHeal: false, changedBy: null, operator: null });
  expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
});
it("engage_with_listing_down_still_engages_but_is_not_owned", async () => {
  const f = fake();
  f.port.listKillSwitches.mockRejectedValue(new Error("synthetic failure"));
  expect(await engageFixtureHealBrake(f.port, engageInput)).toEqual({ kind: "engaged", version: 4, owned: false });
});
it("engage_contested_version_jump_is_not_owned", async () => {
  const f = fake();
  f.state.beforeSet = () => { f.state.provider = row({ version: 4, engaged: true, operator: "blaine" }); };
  expect(await engageFixtureHealBrake(f.port, engageInput)).toEqual({ kind: "engaged", version: 5, owned: false });
});
it("engage_rpc_unavailable_falls_back_to_process_local_pause", async () => {
  for (const stalls of [false, true]) {
    const f = fake();
    f.port.listKillSwitches.mockRejectedValue(new Error("synthetic failure"));
    f.port.setProviderKillSwitch.mockImplementation(() => stalls ? new Promise(() => {}) : Promise.reject(new Error("synthetic failure")));
    const pages: FixtureHealPage[] = [];
    const pause = createSupplierPauseSwitch({ page: (page) => { pages.push(page); throw new Error("page failed"); } });
    const pending = pause.pause({ ...pauseInput, brake: f.port, brakeTimeoutMs: 5 });
    expect(pause.isPaused(provider)).toBe(true);
    expect(pause.admits(provider, { internalTestQuote: false })).toBe(false);
    expect((await pending).durable.kind).toBe("unavailable");
    expect(pages).toHaveLength(1);
    expect(pages[0].brakeCommand).toContain("npm run provider:kill");
    expect(pages[0].durableBrake?.kind).toBe("unavailable");
  }
});
it("release_by_fixture_heal_with_matching_cas", async () => {
  const f = fake();
  const receipt = await engageFixtureHealBrake(f.port, engageInput);
  if (receipt.kind !== "engaged" || !receipt.owned) throw new Error("expected own receipt");
  f.state.global = row({ engaged: true }); // Global traffic remains blocked independently.
  expect(await releaseFixtureHealBrake(f.port, { ...releaseInput, expectedVersion: receipt.version })).toEqual({ kind: "released", version: 5 });
  expect(f.port.setProviderKillSwitch.mock.calls[1][0]).toMatchObject({ engaged: false, operator: "fixture-heal", expectedVersion: 4,
    reason: expect.stringMatching(/^fixture-heal release reverify /) });
  expect(parseKillSwitchListing(await f.port.listKillSwitches(), provider)?.provider?.engaged).toBe(false);
  expect(f.state.global.engaged).toBe(true);
});
it("release_refused_when_human_engaged", async () => {
  for (const owner of [{ changedBy: "00000000-0000-0000-0000-000000000001", operator: null }, { changedBy: "cli:service_role", operator: "blaine" }]) {
    const f = fake(row({ engaged: true, ...owner }));
    expect(await releaseFixtureHealBrake(f.port, releaseInput)).toEqual({ kind: "refused", reason: "not_fixture_heal" });
    expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
  }
});
it("release_refused_on_stale_cas_version", async () => {
  const f = fake(row({ engaged: true }));
  expect(await releaseFixtureHealBrake(f.port, releaseInput)).toEqual({ kind: "refused", reason: "stale_version" });
  expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
  f.state.provider = row({ engaged: true, version: 4 });
  f.state.beforeSet = () => { f.state.provider = row({ engaged: true, version: 5 }); };
  expect(await releaseFixtureHealBrake(f.port, releaseInput)).toEqual({ kind: "refused", reason: "stale_version" });
  expect(f.port.setProviderKillSwitch).toHaveBeenCalledTimes(1);
});
it("release_refused_when_not_engaged_or_invalid", async () => {
  const f = fake();
  expect(await releaseFixtureHealBrake(f.port, releaseInput)).toEqual({ kind: "refused", reason: "not_engaged" });
  const missing = fake(null);
  expect(await releaseFixtureHealBrake(missing.port, releaseInput)).toEqual({ kind: "refused", reason: "not_fixture_heal" });
  f.port.listKillSwitches.mockClear();
  for (const change of [{ evidenceRef: " " }, { via: "invalid" }, { expectedVersion: -1 }, { expectedVersion: 1.5 }]) {
    expect(await releaseFixtureHealBrake(f.port, { ...releaseInput, ...change } as typeof releaseInput)).toEqual({ kind: "refused", reason: "invalid_request" });
  }
  expect(f.port.listKillSwitches).not.toHaveBeenCalled();
  expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
});
it("release_rpc_unavailable_keeps_pause", async () => {
  const f = fake();
  const pause = createSupplierPauseSwitch({ page: () => {} });
  await pause.pause({ ...pauseInput, brake: f.port });
  f.port.listKillSwitches.mockRejectedValueOnce(new Error("synthetic failure"));
  expect((await pause.releaseDurable(provider, releaseInput, f.port)).kind).toBe("unavailable");
  expect(pause.isPaused(provider)).toBe(true);
  expect(await pause.releaseDurable(provider, { ...releaseInput, expectedVersion: 0 }, f.port)).toEqual({ kind: "refused", reason: "stale_version" });
  expect(pause.isPaused(provider)).toBe(true);
  expect((await pause.releaseDurable(provider, releaseInput, f.port)).kind).toBe("released");
  expect(pause.isPaused(provider)).toBe(false);
});
it("gate_records_brake_receipt_on_the_held_result", async () => {
  const output: VendorQuoteAdapterOutput = { vendor: provider, status: "instant_quote_received", unitPriceUsd: 0,
    totalPriceUsd: 0, leadTimeBusinessDays: 1, quoteUrl: null, dfmIssues: [], notes: [], artifacts: [], rawPayload: {} };
  const context: FixtureSanityContext = { provider, vendorQuoteResultId: "synthetic-result", quoteRunId: "synthetic-run",
    requestedQuantity: 1, requirement: null, packageId: null, internalTestQuote: false };
  const f = fake();
  const gate = createFixtureSanityGate({ history: async () => ({ available: true, history: [], peers: [] }),
    pause: createSupplierPauseSwitch({ page: () => {} }), brake: f.port });
  const passing = await gate({ ...output, unitPriceUsd: 10, totalPriceUsd: 10 }, context);
  expect(passing.brake).toBeNull();
  expect(passing.output.rawPayload.fixtureSanity).not.toHaveProperty("brake");
  expect(f.port.listKillSwitches).not.toHaveBeenCalled();
  expect(f.port.setProviderKillSwitch).not.toHaveBeenCalled();
  const held = await gate(output, context);
  expect(held.held).toBe(true);
  expect(held.output.rawPayload.fixtureSanity).toMatchObject({ brake: { operator: "fixture-heal", kind: "engaged", owned: true, version: 4 } });
  expect(held.brake).toEqual({ kind: "engaged", owned: true, version: 4 });
});
it("permit_flag_off_returns_the_base_reader", async () => {
  const f = fake(row({ engaged: true }));
  for (const settings of [{ mode: "off" as const, internalTestQuote: true }, { mode: "on" as const, internalTestQuote: false }]) {
    const reader = createCertificationPermitKillSwitchReader({ ...settings, base: f.base, port: f.port, provider });
    expect(reader).toBe(f.base);
    await reader(provider);
  }
  expect(f.port.listKillSwitches).not.toHaveBeenCalled();
});
const policy = { internalOrganizationIds: new Set(["internal-org"]), goldenPartIds: new Set(["golden-part"]) };
const internalTask = { marker: { internal: true }, organizationId: "internal-org", partId: "golden-part" };
it("permit_exception_only_internal_org_golden_part", async () => {
  for (const task of [internalTask, { ...internalTask, organizationId: "customer-org" }, { ...internalTask, partId: "other-part" }, { ...internalTask, marker: {} }]) {
    const f = fake(row({ engaged: true }));
    const internal = isInternalTestQuote(task, policy);
    const reader = permitReader(f, internal);
    if (task === internalTask) {
      expect(await reader(provider)).toEqual({ schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged: false, globalEngaged: false });
      await expect(assertReader(reader)).resolves.toBeUndefined();
    } else {
      expect(reader).toBe(f.base);
      await expect(assertReader(reader)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged" });
    }
  }
});
it("permit_exception_customer_task_denied", async () => {
  const f = fake(row({ engaged: true }));
  const internal = isInternalTestQuote({ ...internalTask, organizationId: "customer-org" }, policy);
  await expect(assertReader(permitReader(f, internal))).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged" });
  expect(f.port.listKillSwitches).not.toHaveBeenCalled();
});
it("permit_never_bypasses_a_human_or_global_switch", async () => {
  for (const scenario of ["human", "global", "missing", "throws", "malformed"]) {
    const f = fake(row({ engaged: true }));
    if (scenario === "human") f.state.provider = row({ engaged: true, operator: "blaine" });
    if (scenario === "global") f.state.global = row({ engaged: true });
    if (scenario === "missing") f.state.global = null;
    if (scenario === "throws") f.port.listKillSwitches.mockRejectedValue(new Error("synthetic failure"));
    if (scenario === "malformed") f.port.listKillSwitches.mockResolvedValue({});
    await expect(assertReader(permitReader(f))).rejects.toMatchObject({ reasonCode:
      ["throws", "malformed"].includes(scenario) ? "provider_kill_switch_unavailable" : "provider_kill_switch_engaged" });
  }
});
it("permit_pins_the_claim_version", async () => {
  const f = fake(row({ engaged: true }));
  const reader = permitReader(f);
  await expect(assertReader(reader)).resolves.toBeUndefined();
  await f.port.setProviderKillSwitch({ provider, engaged: true, operator: "fixture-heal", reason: "synthetic reengage" });
  await expect(assertReader(reader)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged" });
  expect(f.port.listKillSwitches).toHaveBeenCalledTimes(2);
});
it("permit_is_decided_at_claim_only", async () => {
  // Not permitted at claim (switch released): a fixture-heal engage while the
  // task runs must not start permitting it at a later checkpoint.
  const f = fake(row({ engaged: false }));
  const reader = permitReader(f);
  await expect(assertReader(reader)).resolves.toBeUndefined();
  await engageFixtureHealBrake(f.port, engageInput);
  await expect(assertReader(reader)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged" });
  expect(f.port.listKillSwitches).toHaveBeenCalledTimes(2); // one claim read, one by the engage; none after claim
});
it("engage_reason_lists_every_code", async () => {
  const f = fake();
  await engageFixtureHealBrake(f.port, { ...engageInput, codes: ["price_missing", "material_echo"] });
  expect(f.port.setProviderKillSwitch.mock.calls[0][0].reason).toBe("fixture-heal sanity price_missing,material_echo run synthetic-run");
});
it("anon_authenticated_cannot_call_brake_rpc", () => {
  // Runtime denial is pinned by supabase/tests/ovd771_service_kill_switch.sql pgTAP.
  const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261015221725_ovd771_service_kill_switch.sql", import.meta.url)), "utf8");
  for (const signature of [
    "api_service_set_provider_kill_switch(public.vendor_name, boolean, text, text, bigint)",
    "api_service_list_provider_kill_switches()",
  ]) {
    expect(sql).toContain(`revoke all on function public.${signature}\n  from public, anon, authenticated, service_role;`);
    expect(sql).toContain(`grant execute on function public.${signature}\n  to service_role;`);
  }
  const source = readFileSync(fileURLToPath(new URL("./brake.ts", import.meta.url)), "utf8");
  expect(source.match(/"api_service_[a-z_]+"/g)).toEqual([
    '"api_service_set_provider_kill_switch"', '"api_service_list_provider_kill_switches"',
  ]);
});

it("strict_brake_payloads_fail_closed", async () => {
  const f = fake(row({ engaged: true }));
  const listing = await f.port.listKillSwitches() as Record<string, unknown>;
  for (const invalid of [null, {}, { ...listing, schema: "wrong" }, { ...listing, providers: {} },
    { ...listing, global: undefined }, { ...listing, providers: [{ provider, ...row({ version: -1 }) }] },
    { ...listing, providers: [{ provider, ...row(), operator: undefined }] },
    { ...listing, providers: [{ provider, ...row() }, { provider, ...row() }] }]) {
    expect(parseKillSwitchListing(invalid, provider)).toBeNull();
  }
  for (const invalid of [null, { provider, ...row({ engaged: true, operator: "blaine" }) },
    { provider, ...row({ engaged: true, version: 1.5 }) }, { provider, ...row({ engaged: false }) }]) {
    const broken = fake();
    broken.port.setProviderKillSwitch.mockResolvedValue(invalid);
    expect((await engageFixtureHealBrake(broken.port, engageInput)).kind).toBe("unavailable");
  }
  expect(decideCertificationPermit({ mode: "on", internalTestQuote: true, listing: null })).toEqual({ permitted: false, reason: "listing_unavailable" });
});
it("supabase_brake_port_uses_fixed_errors_and_optional_cas", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
  const port = supabaseFixtureHealBrakePort({ rpc } as unknown as SupabaseClient);
  await port.listKillSwitches();
  expect(rpc).toHaveBeenLastCalledWith(SERVICE_LIST_KILL_SWITCHES_RPC);
  await port.setProviderKillSwitch({ provider, engaged: true, reason: "synthetic reason", operator: "fixture-heal" });
  expect(rpc).toHaveBeenLastCalledWith(SERVICE_SET_PROVIDER_KILL_SWITCH_RPC, {
    p_provider: provider, p_engaged: true, p_reason: "synthetic reason", p_operator: "fixture-heal",
  });
  await port.setProviderKillSwitch({ provider, engaged: false, reason: "synthetic reason", operator: "fixture-heal", expectedVersion: 4 });
  expect(rpc.mock.calls.at(-1)?.[1]).toHaveProperty("p_expected_version", 4);
  rpc.mockResolvedValue({ data: null, error: { message: "synthetic kill_switch_version_conflict detail" } });
  await expect(port.setProviderKillSwitch({ provider, engaged: false, reason: "synthetic reason", operator: "fixture-heal" })).rejects.toThrow(FixtureHealBrakeConflictError);
  rpc.mockResolvedValue({ data: null, error: { message: "synthetic private detail" } });
  await expect(port.listKillSwitches()).rejects.toThrow("fixture heal brake listing failed");
  await expect(port.setProviderKillSwitch({ provider, engaged: true, reason: "synthetic reason", operator: "fixture-heal" })).rejects.toThrow("fixture heal brake write failed");
});
