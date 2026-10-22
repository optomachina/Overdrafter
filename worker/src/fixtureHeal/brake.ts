/**
 * OVD-817 (OVD-796 S2): the durable supplier brake. Fixture-heal engages and
 * releases the per-provider kill switch through the OVD-771 service_role RPCs
 * (`api_service_set_provider_kill_switch`, `api_service_list_provider_kill_switches`),
 * the same ones `npm run provider:kill` uses, as operator `fixture-heal`.
 *
 * Kill switches always win (D9). Self-heal may release only a switch it
 * engaged itself, so:
 *   * engage never writes over an engaged switch (a human's engagement would
 *     otherwise be relabelled operator `fixture-heal` and become releasable),
 *     and never creates a missing row (a missing row already reads engaged);
 *   * an engage is "owned" only when the listing showed the switch released
 *     and our write moved the version by exactly one; a failed listing or a
 *     version jump means someone else may have flipped it, so it is not owned;
 *   * release needs the version from our own owned engage receipt, re-checks
 *     the current row (engaged, actor `cli:service_role`, operator
 *     `fixture-heal`, same version), and sends that version as the database
 *     compare and set, which refuses if anything changed in between.
 * Every call is time-bounded and nothing here throws: an unavailable RPC
 * leaves the process-local pause in place (pause.ts), and the gate holds the
 * quote either way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorName } from "../types.js";

export const FIXTURE_HEAL_OPERATOR = "fixture-heal";
export const FIXTURE_HEAL_BRAKE_ACTOR = "cli:service_role";
export const SERVICE_SET_PROVIDER_KILL_SWITCH_RPC = "api_service_set_provider_kill_switch";
export const SERVICE_LIST_KILL_SWITCHES_RPC = "api_service_list_provider_kill_switches";
export const SERVICE_KILL_SWITCH_LIST_SCHEMA = "provider-kill-switch-service.v1";
export const FIXTURE_HEAL_BRAKE_TIMEOUT_MS = 2_000;

export type FixtureHealBrakePort = {
  /** Raw service listing; throws on any transport/SQL error. */
  listKillSwitches(): Promise<unknown>;
  /** Raw set result; version conflicts throw FixtureHealBrakeConflictError. */
  setProviderKillSwitch(args: {
    provider: VendorName; engaged: boolean; reason: string; operator: string; expectedVersion?: number;
  }): Promise<unknown>;
};
export class FixtureHealBrakeConflictError extends Error {}

export function supabaseFixtureHealBrakePort(supabase: SupabaseClient): FixtureHealBrakePort {
  return {
    async listKillSwitches() {
      try {
        const { data, error } = await supabase.rpc(SERVICE_LIST_KILL_SWITCHES_RPC);
        if (error) throw new Error("fixture heal brake listing failed");
        return data;
      } catch {
        throw new Error("fixture heal brake listing failed");
      }
    },
    async setProviderKillSwitch(args) {
      try {
        const { data, error } = await supabase.rpc(SERVICE_SET_PROVIDER_KILL_SWITCH_RPC, {
          p_provider: args.provider,
          p_engaged: args.engaged,
          p_reason: args.reason,
          p_operator: args.operator,
          ...(args.expectedVersion === undefined ? {} : { p_expected_version: args.expectedVersion }),
        });
        if (error) {
          if (error.message?.includes("kill_switch_version_conflict")) {
            throw new FixtureHealBrakeConflictError("fixture heal brake version conflict");
          }
          throw new Error("fixture heal brake write failed");
        }
        return data;
      } catch (error) {
        if (error instanceof FixtureHealBrakeConflictError ||
          (error instanceof Error && error.message.includes("kill_switch_version_conflict"))) {
          throw new FixtureHealBrakeConflictError("fixture heal brake version conflict");
        }
        throw new Error("fixture heal brake write failed");
      }
    },
  };
}

export type KillSwitchRow = { engaged: boolean; version: number; changedBy: string | null; operator: string | null };
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const validVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function parseRow(value: unknown): KillSwitchRow | null {
  const row = record(value);
  if (!row || typeof row.engaged !== "boolean" || !validVersion(row.version) ||
    !(row.changedBy === null || typeof row.changedBy === "string") ||
    !(row.operator === null || typeof row.operator === "string")) return null;
  return { engaged: row.engaged, version: row.version, changedBy: row.changedBy, operator: row.operator };
}

export function parseKillSwitchListing(data: unknown, provider: VendorName): {
  global: KillSwitchRow | null; globalPresent: boolean; provider: KillSwitchRow | null;
} | null {
  const listing = record(data);
  if (!listing || listing.schema !== SERVICE_KILL_SWITCH_LIST_SCHEMA || !Array.isArray(listing.providers)) return null;
  const global = parseRow(listing.global);
  if (listing.global !== null && !global) return null;
  let selected: KillSwitchRow | null = null;
  const seen = new Set<string>();
  for (const value of listing.providers) {
    const fields = record(value);
    const row = parseRow(value);
    if (!fields || !row || typeof fields.provider !== "string" || !fields.provider || seen.has(fields.provider)) return null;
    seen.add(fields.provider);
    if (fields.provider === provider) selected = row;
  }
  return { global, globalPresent: global !== null, provider: selected };
}

export function isFixtureHealOwned(row: KillSwitchRow): boolean {
  return row.engaged === true && row.changedBy === FIXTURE_HEAL_BRAKE_ACTOR && row.operator === FIXTURE_HEAL_OPERATOR;
}

function parseSetResult(data: unknown, provider: VendorName, engaged: boolean): KillSwitchRow | null {
  const row = parseRow(data);
  return row && record(data)?.provider === provider && row.engaged === engaged &&
    row.operator === FIXTURE_HEAL_OPERATOR && row.changedBy === FIXTURE_HEAL_BRAKE_ACTOR ? row : null;
}

/** Bound every RPC independently; a stalled listing must not prevent a safe engage. */
export async function withFixtureHealBrakeTimeout<T>(call: () => Promise<T>, timeoutMs = FIXTURE_HEAL_BRAKE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture heal brake timed out")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const safe = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, "_");

export type FixtureHealEngageOutcome =
  | { kind: "engaged"; version: number; owned: boolean }
  | { kind: "already_engaged"; version: number | null; ownedByFixtureHeal: boolean; changedBy: string | null; operator: string | null }
  | { kind: "unavailable"; reason: string };

export async function engageFixtureHealBrake(port: FixtureHealBrakePort, input: {
  provider: VendorName; codes: string[]; runId: string; timeoutMs?: number;
}): Promise<FixtureHealEngageOutcome> {
  try {
    const listing = await withFixtureHealBrakeTimeout(() => port.listKillSwitches(), input.timeoutMs)
      .then((data) => parseKillSwitchListing(data, input.provider)).catch(() => null);
    if (listing && (!listing.provider || listing.provider.engaged)) {
      return { kind: "already_engaged", version: listing.provider?.version ?? null,
        ownedByFixtureHeal: listing.provider ? isFixtureHealOwned(listing.provider) : false,
        changedBy: listing.provider?.changedBy ?? null, operator: listing.provider?.operator ?? null };
    }
    const data = await withFixtureHealBrakeTimeout(() => port.setProviderKillSwitch({
      provider: input.provider, engaged: true, operator: FIXTURE_HEAL_OPERATOR,
      reason: `fixture-heal sanity ${input.codes.length > 0 ? input.codes.map(safe).join(",") : "unknown"} run ${safe(input.runId)}`.slice(0, 200),
    }), input.timeoutMs);
    const row = parseSetResult(data, input.provider, true);
    if (!row) return { kind: "unavailable", reason: "brake_result_invalid" };
    return { kind: "engaged", version: row.version,
      owned: !!listing?.provider && !listing.provider.engaged && row.version === listing.provider.version + 1 };
  } catch {
    return { kind: "unavailable", reason: "brake_engage_failed" };
  }
}

export type FixtureHealReleaseOutcome =
  | { kind: "released"; version: number }
  | { kind: "refused"; reason: "invalid_request" | "not_engaged" | "not_fixture_heal" | "stale_version" }
  | { kind: "unavailable"; reason: string };

export async function releaseFixtureHealBrake(port: FixtureHealBrakePort, input: {
  provider: VendorName;
  /** From this caller's own engaged/owned:true receipt, NEVER a read-back listing version. */
  expectedVersion: number;
  via: "reverify" | "heal"; evidenceRef: string; timeoutMs?: number;
}): Promise<FixtureHealReleaseOutcome> {
  if ((input.via !== "reverify" && input.via !== "heal") || typeof input.evidenceRef !== "string" ||
    !input.evidenceRef.trim() || !validVersion(input.expectedVersion)) return { kind: "refused", reason: "invalid_request" };
  try {
    const listing = parseKillSwitchListing(await withFixtureHealBrakeTimeout(() => port.listKillSwitches(), input.timeoutMs), input.provider);
    if (!listing) return { kind: "unavailable", reason: "brake_listing_invalid" };
    const row = listing.provider;
    if (!row) return { kind: "refused", reason: "not_fixture_heal" };
    if (!row.engaged) return { kind: "refused", reason: "not_engaged" };
    if (!isFixtureHealOwned(row)) return { kind: "refused", reason: "not_fixture_heal" };
    if (row.version !== input.expectedVersion) return { kind: "refused", reason: "stale_version" };
    const data = await withFixtureHealBrakeTimeout(() => port.setProviderKillSwitch({
      provider: input.provider, engaged: false, operator: FIXTURE_HEAL_OPERATOR, expectedVersion: input.expectedVersion,
      reason: `fixture-heal release ${safe(input.via)} ${safe(input.evidenceRef.trim())}`.slice(0, 200),
    }), input.timeoutMs);
    const result = parseSetResult(data, input.provider, false);
    return result ? { kind: "released", version: result.version } : { kind: "unavailable", reason: "brake_result_invalid" };
  } catch (error) {
    return error instanceof FixtureHealBrakeConflictError ? { kind: "refused", reason: "stale_version" } :
      { kind: "unavailable", reason: "brake_release_failed" };
  }
}
