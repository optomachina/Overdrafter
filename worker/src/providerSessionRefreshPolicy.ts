import type { SessionHealthRecord } from "./providerSessionHealth";

export const KEEP_VERSIONS = 5;
export const MAX_LOGINS_PER_24H = 3;
export const BACKOFF_MS = [60e3, 300e3, 1800e3] as const;
export const KILL_SWITCH_AFTER_FAILED_CYCLES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RefreshHistory = {
  /** Epoch ms of each login attempt, any order. */
  loginAttemptsAt: readonly number[];
  /** Consecutive failed attempts since the last success. */
  consecutiveFailures: number;
  lastAttemptAt: number | null;
};

export type RefreshDecision =
  | { allowed: true }
  | { allowed: false; reason: "healthy" | "human_required" | "login_budget_exhausted" | "backoff"; retryAt?: number };

/** MFA and captcha/challenge pages need a human; automated retries only risk lockout. */
export function requiresHuman(record: Pick<SessionHealthRecord, "state" | "reason">): boolean {
  return record.state === "mfa_required" || (record.state === "blocked" && record.reason === "challenge_page");
}

/** Delay before the attempt following `consecutiveFailures` failures; the last step repeats. */
export function nextBackoffMs(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[index];
}

export function decideRefresh(record: SessionHealthRecord, history: RefreshHistory, nowMs: number): RefreshDecision {
  if (record.state === "authenticated") return { allowed: false, reason: "healthy" };
  if (requiresHuman(record)) return { allowed: false, reason: "human_required" };
  const recent = history.loginAttemptsAt.filter((at) => nowMs - at < DAY_MS);
  if (recent.length >= MAX_LOGINS_PER_24H) {
    return { allowed: false, reason: "login_budget_exhausted", retryAt: Math.min(...recent) + DAY_MS };
  }
  if (history.consecutiveFailures > 0 && history.lastAttemptAt !== null) {
    const retryAt = history.lastAttemptAt + nextBackoffMs(history.consecutiveFailures);
    if (nowMs < retryAt) return { allowed: false, reason: "backoff", retryAt };
  }
  return { allowed: true };
}

export function shouldTripKillSwitch(failedCycles: number): boolean {
  return failedCycles >= KILL_SWITCH_AFTER_FAILED_CYCLES;
}
