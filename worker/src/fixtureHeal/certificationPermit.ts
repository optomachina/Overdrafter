/**
 * OVD-817 (OVD-796 §9): the certification-permit exception, default off
 * (`WORKER_FIXTURE_HEAL_CERT_PERMIT`). A killed supplier cannot be certified,
 * because certification goes through every kill-switch checkpoint. With the
 * flag on, a verified internal test quote (internal certification org, golden
 * part, `fixtureHeal.internal` marker) may pass the worker's kill-switch reads
 * only while the provider switch is engaged by fixture-heal itself and the
 * global switch is present and released. A switch a human engaged, a global
 * brake, or an unreadable listing is never bypassed (kill switches win, D9).
 *
 * Worker-side only: server api_authorize_* dispatch preflight, the enqueue
 * trigger, api_worker_cancel_provider_disabled_tasks queued-task sweep, and
 * durable dispatch reservation still refuse a killed supplier. This exception
 * is inert end to end until reviewed fixture-heal-a SQL (OVD-815 / S8) honours
 * it. Keeping those gates closed is intentional until that review.
 */
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA, type ProviderKillSwitchReader } from "../providerSettings.js";
import type { VendorName } from "../types.js";
import { isFixtureHealOwned, parseKillSwitchListing, withFixtureHealBrakeTimeout, type FixtureHealBrakePort } from "./brake.js";

export const FIXTURE_HEAL_CERT_PERMIT_ENV = "WORKER_FIXTURE_HEAL_CERT_PERMIT";
export type CertificationPermitMode = "off" | "on";
export type CertificationPermitDecision =
  | { permitted: true; version: number }
  | { permitted: false; reason: "flag_off" | "not_internal_test_quote" | "listing_unavailable" | "switch_not_engaged"
    | "global_engaged" | "not_fixture_heal" | "version_changed" };

export function decideCertificationPermit(input: {
  mode: CertificationPermitMode; internalTestQuote: boolean;
  listing: ReturnType<typeof parseKillSwitchListing>; pinnedVersion?: number | null;
}): CertificationPermitDecision {
  if (input.mode !== "on") return { permitted: false, reason: "flag_off" };
  if (!input.internalTestQuote) return { permitted: false, reason: "not_internal_test_quote" };
  const listing = input.listing;
  if (!listing) return { permitted: false, reason: "listing_unavailable" };
  if (!listing.globalPresent || !listing.global || listing.global.engaged) return { permitted: false, reason: "global_engaged" };
  if (!listing.provider) return { permitted: false, reason: "not_fixture_heal" };
  if (!listing.provider.engaged) return { permitted: false, reason: "switch_not_engaged" };
  if (!isFixtureHealOwned(listing.provider)) return { permitted: false, reason: "not_fixture_heal" };
  if (input.pinnedVersion != null && input.pinnedVersion !== listing.provider.version) return { permitted: false, reason: "version_changed" };
  return { permitted: true, version: listing.provider.version };
}

export function createCertificationPermitKillSwitchReader(input: {
  base: ProviderKillSwitchReader; port: Pick<FixtureHealBrakePort, "listKillSwitches">;
  provider: VendorName; mode: CertificationPermitMode; internalTestQuote: boolean;
}): ProviderKillSwitchReader {
  if (input.mode !== "on" || !input.internalTestQuote) return input.base;
  // The permit is decided once, at the first successful read (the claim
  // check). A task that was not permitted at claim is never permitted later,
  // even if fixture-heal engages the switch while it runs; a permitted task
  // keeps the permit only while the switch stays at the claim's version.
  let claim: { permitted: true; version: number } | { permitted: false } | null = null;
  return async (provider) => {
    // A task's permit must never be reused for a different supplier.
    if (provider !== input.provider || claim?.permitted === false) return input.base(provider);
    const listing = parseKillSwitchListing(await withFixtureHealBrakeTimeout(() => input.port.listKillSwitches()), provider);
    if (!listing) throw new Error("fixture heal certification listing unavailable");
    const decision = decideCertificationPermit({ ...input, listing, pinnedVersion: claim?.permitted ? claim.version : null });
    claim ??= decision.permitted ? { permitted: true, version: decision.version } : { permitted: false };
    if (!decision.permitted) return input.base(provider);
    return { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged: false, globalEngaged: false };
  };
}
