import {
  isProviderKillSwitchEngaged,
  type ProviderKillSwitchGuard,
} from "./providerKillSwitch.js";
import type { SessionProbeEvidence, SessionProbeOutcome, SessionProbeReason } from "./providerSessionProbe.js";
import type { VendorName } from "./types.js";

/**
 * OVD-763 slice 1: provider session health status and probe scheduling.
 *
 * Pure and injectable. This module never opens a browser, never calls a vendor
 * and never reads a secret; the real probe is passed in as a HealthProbe. A
 * health record holds the provider, a status, a fixed reason code, timestamps
 * and counts, and nothing else: no storage state, cookies, keys, URLs, page
 * content or error text.
 */

export const HEALTH_PROVIDERS = ["fictiv", "quickparts", "xometry", "rmfg"] as const satisfies readonly VendorName[];
export type HealthProvider = (typeof HEALTH_PROVIDERS)[number];

export type ProviderHealthStatus = "healthy" | "logged_out" | "blocked" | "error" | "unknown";

export type HealthReason =
  | SessionProbeReason
  | "provider_kill_switch_engaged"
  | "provider_kill_switch_unavailable"
  | "probe_threw"
  | "probe_result_invalid"
  | "probe_reason_invalid";

export type ProviderHealthRecord = {
  provider: HealthProvider;
  status: ProviderHealthStatus;
  reason: HealthReason;
  /** ISO timestamp of the last probe attempt (or the first skip when never probed). */
  checkedAt: string;
  consecutiveFailures: number;
  lastHealthyAt: string | null;
  /** True when the status differs from the previous record's status. */
  changed: boolean;
};

/** The slice of SessionProbeEvidence the health check reads. */
export type HealthProbeEvidence = {
  outcome: SessionProbeOutcome;
  reason: SessionProbeReason | string;
};

/** One read only probe attempt for one provider. Implementations must not retry. */
export type HealthProbe = (provider: HealthProvider) => Promise<HealthProbeEvidence | SessionProbeEvidence>;

export interface HealthStore {
  get(provider: HealthProvider): Promise<ProviderHealthRecord | null>;
  put(record: ProviderHealthRecord): Promise<void>;
}

export function createInMemoryHealthStore(initial: readonly ProviderHealthRecord[] = []): HealthStore {
  const records = new Map<HealthProvider, ProviderHealthRecord>(initial.map((record) => [record.provider, { ...record }]));
  return {
    get: async (provider) => {
      const record = records.get(provider);
      return record ? { ...record } : null;
    },
    put: async (record) => {
      records.set(record.provider, { ...record });
    },
  };
}

/** Binds the kill switch guard to one provider, as createProviderKillSwitchGuard does. */
export type HealthKillSwitchGuard = (provider: HealthProvider) => ProviderKillSwitchGuard;

export const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_DISPATCH_MAX_AGE_MS = 15 * 60 * 1000;
/** A blocked provider is off for the day (see provider-session-probe.md); it is not probed again sooner. */
export const BLOCKED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const OUTCOMES: readonly string[] = ["authenticated", "logged_out", "blocked", "error"];
const REASON_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * authenticated is healthy; logged_out, blocked and error map to themselves,
 * except an HTTP 401 answer, which means the credential was rejected and reads
 * logged_out whichever way the probe classed it (the RMFG probe reports its 401
 * as blocked).
 */
export function mapProbeOutcomeToHealth(evidence: HealthProbeEvidence): ProviderHealthStatus {
  switch (evidence.outcome) {
    case "authenticated":
      return "healthy";
    case "logged_out":
      return "logged_out";
    case "blocked":
      return evidence.reason === "http_unauthorized" ? "logged_out" : "blocked";
    case "error":
      return "error";
    default:
      return "error";
  }
}

function sanitizeEvidence(evidence: unknown): { status: ProviderHealthStatus; reason: HealthReason } {
  if (!evidence || typeof evidence !== "object") return { status: "error", reason: "probe_result_invalid" };
  const { outcome, reason } = evidence as { outcome?: unknown; reason?: unknown };
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    return { status: "error", reason: "probe_result_invalid" };
  }
  // Only a short code is kept, so free text from a probe can never reach a record.
  const code: HealthReason = typeof reason === "string" && REASON_CODE.test(reason) ? (reason as HealthReason) : "probe_reason_invalid";
  return { status: mapProbeOutcomeToHealth({ outcome: outcome as SessionProbeOutcome, reason: code }), reason: code };
}

export async function runProviderHealthCheck(input: {
  providers: readonly HealthProvider[];
  probe: HealthProbe;
  store: HealthStore;
  now: () => Date;
  killSwitchGuard?: HealthKillSwitchGuard;
}): Promise<ProviderHealthRecord[]> {
  const results: ProviderHealthRecord[] = [];
  for (const provider of input.providers) {
    const previous = await input.store.get(provider);

    if (input.killSwitchGuard) {
      try {
        await input.killSwitchGuard(provider)("before_launch");
      } catch (error) {
        // Fail closed: an engaged or unreadable switch means no probe. The
        // status stays as it was; only the reason says why nothing ran.
        const record: ProviderHealthRecord = {
          provider,
          status: previous?.status ?? "unknown",
          reason: isProviderKillSwitchEngaged(error) ? "provider_kill_switch_engaged" : "provider_kill_switch_unavailable",
          checkedAt: previous?.checkedAt ?? input.now().toISOString(),
          consecutiveFailures: previous?.consecutiveFailures ?? 0,
          lastHealthyAt: previous?.lastHealthyAt ?? null,
          changed: false,
        };
        await input.store.put(record);
        results.push(record);
        continue;
      }
    }

    let outcome: { status: ProviderHealthStatus; reason: HealthReason };
    try {
      outcome = sanitizeEvidence(await input.probe(provider));
    } catch {
      // The thrown value is dropped unread: its message could carry a secret.
      outcome = { status: "error", reason: "probe_threw" };
    }

    const checkedAt = input.now().toISOString();
    const record: ProviderHealthRecord = {
      provider,
      status: outcome.status,
      reason: outcome.reason,
      checkedAt,
      consecutiveFailures: outcome.status === "healthy" ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      lastHealthyAt: outcome.status === "healthy" ? checkedAt : (previous?.lastHealthyAt ?? null),
      changed: (previous?.status ?? "unknown") !== outcome.status,
    };
    await input.store.put(record);
    results.push(record);
  }
  return results;
}

function ageMs(record: ProviderHealthRecord, now: Date): number | null {
  const checked = Date.parse(record.checkedAt);
  return Number.isNaN(checked) ? null : now.getTime() - checked;
}

function dueAfter(record: ProviderHealthRecord, now: Date, thresholdMs: number): boolean {
  const age = ageMs(record, now);
  if (age === null || age < 0) return true;
  const effective = record.status === "blocked" ? Math.max(thresholdMs, BLOCKED_COOLDOWN_MS) : thresholdMs;
  return age >= effective;
}

/** Scheduled probe: due when never probed, unknown, or the last probe is at least intervalMs old. */
export function isProbeDue(record: ProviderHealthRecord | null, now: Date, intervalMs = DEFAULT_PROBE_INTERVAL_MS): boolean {
  if (!record || record.status === "unknown") return true;
  return dueAfter(record, now, intervalMs);
}

/** Pre dispatch probe: due when there is no fresh record (older than maxAgeMs). */
export function shouldProbeBeforeDispatch(
  record: ProviderHealthRecord | null,
  now: Date,
  maxAgeMs = DEFAULT_DISPATCH_MAX_AGE_MS,
): boolean {
  if (!record || record.status === "unknown") return true;
  return dueAfter(record, now, maxAgeMs);
}
