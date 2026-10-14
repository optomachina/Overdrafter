import type { SessionProbeEvidence } from "./providerSessionProbe";

/** Providers whose session health is tracked. Probe support is decided by the injected probe. */
export const SESSION_HEALTH_PROVIDERS = ["fictiv", "quickparts", "xometry", "rmfg"] as const;
export type SessionHealthProvider = (typeof SESSION_HEALTH_PROVIDERS)[number];

export type SessionHealthState = "authenticated" | "logged_out" | "blocked" | "mfa_required" | "error";

/** Reason is a probe reason code, never page content, URLs or credentials. */
export type SessionHealthRecord = {
  provider: SessionHealthProvider;
  state: SessionHealthState;
  checkedAt: string;
  reason: string;
};

export type SessionHealthProbe = (
  provider: SessionHealthProvider,
) => Promise<Pick<SessionProbeEvidence, "outcome" | "reason">>;

type HealthDeps = { probe: SessionHealthProbe; now?: () => Date };

const MFA_REASON = /mfa|otp|two_?factor|2fa/i;

export function classifyProbeResult(result: Pick<SessionProbeEvidence, "outcome" | "reason">): SessionHealthState {
  if (MFA_REASON.test(result.reason)) return "mfa_required";
  return result.outcome;
}

export async function checkProviderSessionHealth(
  provider: SessionHealthProvider,
  deps: HealthDeps,
): Promise<SessionHealthRecord> {
  const now = deps.now ?? (() => new Date());
  try {
    const result = await deps.probe(provider);
    return { provider, state: classifyProbeResult(result), checkedAt: now().toISOString(), reason: result.reason };
  } catch {
    // Probe errors can carry secrets or page text; keep only a fixed code.
    return { provider, state: "error", checkedAt: now().toISOString(), reason: "probe_threw" };
  }
}

export function checkAllProviderSessionHealth(
  deps: HealthDeps,
  providers: readonly SessionHealthProvider[] = SESSION_HEALTH_PROVIDERS,
): Promise<SessionHealthRecord[]> {
  return Promise.all(providers.map((provider) => checkProviderSessionHealth(provider, deps)));
}
