/**
 * OVD-813: the slice 1 supplier pause. The FIRST drift finding (any hard code
 * or the first price outlier, per the Release sign-off on OVD-796) pauses the
 * supplier, pages with the exact brake command, and logs it.
 *
 * This is a per-process switch shaped like `createProviderDaySwitch`, with one
 * deliberate difference: it never expires. The day switch lifts at UTC
 * midnight; a drift pause lifts only through `release` with a re-verify
 * (passing certification) or heal outcome. There is no timer anywhere here.
 *
 * Not durable: another worker instance does not see this pause, and a restart
 * clears it. That gap is accepted for slice 1 only because the gate always
 * holds the drifting quote itself (no wrong price is shown even if another
 * instance keeps quoting). The durable engage through the service_role brake
 * RPC, with release only for operator `fixture-heal` on a matching CAS
 * version, is OVD-771 / slice 2 (OVD-796 S2).
 *
 * The provider kill switch is independent and always wins: admitting an
 * internal test quote here never skips a kill switch checkpoint.
 */

export type SupplierPauseRelease = { via: "reverify" | "heal"; evidenceRef: string };

export type SupplierPauseRecord = {
  provider: string;
  pausedAt: string;
  codes: string[];
  runId: string;
};

export type FixtureHealPage = {
  severity: "page";
  source: "fixture_heal.pause";
  provider: string;
  codes: string[];
  runId: string;
  vendorQuoteResultId: string;
  /** The operator command that makes the pause durable until slice 2 does it automatically. */
  brakeCommand: string;
};

export type SupplierPauseSwitch = {
  /** Pauses the supplier and pages. Repeated findings while paused page again but keep the first record. */
  pause(input: { provider: string; codes: string[]; runId: string; vendorQuoteResultId: string; nowMs: number }): SupplierPauseRecord;
  isPaused(provider: string): boolean;
  current(provider: string): SupplierPauseRecord | null;
  /** A paused supplier admits only a verified internal test quote. */
  admits(provider: string, quote: { internalTestQuote: boolean }): boolean;
  /** Only a re-verify or heal outcome with evidence releases; anything else is refused. */
  release(provider: string, release: SupplierPauseRelease): boolean;
};

export function fixtureHealBrakeCommand(provider: string, code: string, runId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return `npm run provider:kill -- ${safe(provider)} --on --reason "fixture-heal sanity ${safe(code)} run ${safe(runId)}" --operator "<name>"`;
}

/** Default page sink: one structured error line the log alerting pages on. */
export function logFixtureHealPage(page: FixtureHealPage): void {
  console.error(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "error",
      severity: page.severity,
      source: page.source,
      message: `Supplier ${page.provider} paused by the fixture sanity gate (${page.codes.join(", ")}); its quote is held.`,
      context: page,
    }),
  );
}

export function createSupplierPauseSwitch(options: { page?: (page: FixtureHealPage) => void } = {}): SupplierPauseSwitch {
  const paused = new Map<string, SupplierPauseRecord>();
  const page = options.page ?? logFixtureHealPage;
  return {
    pause({ provider, codes, runId, vendorQuoteResultId, nowMs }) {
      const record = paused.get(provider) ?? { provider, pausedAt: new Date(nowMs).toISOString(), codes, runId };
      paused.set(provider, record);
      try {
        page({
          severity: "page",
          source: "fixture_heal.pause",
          provider,
          codes,
          runId,
          vendorQuoteResultId,
          brakeCommand: fixtureHealBrakeCommand(provider, codes[0] ?? "unknown", runId),
        });
      } catch {
        // A failed page never lifts the pause.
      }
      return record;
    },
    isPaused: (provider) => paused.has(provider),
    current: (provider) => paused.get(provider) ?? null,
    admits: (provider, quote) => !paused.has(provider) || quote.internalTestQuote === true,
    release(provider, release) {
      const valid =
        (release?.via === "reverify" || release?.via === "heal") &&
        typeof release.evidenceRef === "string" &&
        release.evidenceRef.trim().length > 0;
      if (!valid || !paused.has(provider)) return false;
      paused.delete(provider);
      return true;
    },
  };
}

// --------------------------------------------------------------------------- internal test quotes

/**
 * Which tasks count as internal test quotes. Both lists come from the worker
 * environment and default to empty, so nothing is internal unless configured.
 * Golden part files arrive with certification (slice 8); until then the part
 * ids are configured directly.
 */
export type InternalTestQuotePolicy = {
  internalOrganizationIds: ReadonlySet<string>;
  goldenPartIds: ReadonlySet<string>;
};

const idList = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

export function internalTestQuotePolicyFromEnv(env: Readonly<Record<string, string | undefined>>): InternalTestQuotePolicy {
  return {
    internalOrganizationIds: idList(env.FIXTURE_HEAL_INTERNAL_ORG_IDS),
    goldenPartIds: idList(env.FIXTURE_HEAL_GOLDEN_PART_IDS),
  };
}

/**
 * A task is an internal test quote only when all three hold: its payload
 * carries `fixtureHeal.internal === true`, its organization is the internal
 * certification org, and its part is a golden part. A marker alone (for
 * example on a customer org task) is ignored.
 */
export function isInternalTestQuote(
  task: { marker: unknown; organizationId: string; partId: string | null },
  policy: InternalTestQuotePolicy,
): boolean {
  const marker = task.marker;
  if (typeof marker !== "object" || marker === null || (marker as { internal?: unknown }).internal !== true) return false;
  return (
    policy.internalOrganizationIds.has(task.organizationId) &&
    task.partId !== null &&
    policy.goldenPartIds.has(task.partId)
  );
}
