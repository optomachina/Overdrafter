export interface RateLimiter {
  /** Records a request and returns true when it fits the window; a refusal records nothing. */
  tryAcquire(userId: string, nowMs: number): boolean;
}

/** Counts failures only; a key with `maxFailures` failures inside the window is blocked. */
export interface FailedAttemptLimiter {
  isBlocked(key: string, nowMs: number): boolean;
  recordFailure(key: string, nowMs: number): void;
  reset(key: string): void;
}

/**
 * Failed link-code attempts per channel + external-id hash (default 5 per 15 minutes), so a
 * 6-digit code cannot be brute-forced inside its expiry. Per process, like the request limiter;
 * it needs a shared store before a real channel goes live.
 */
export function createFailedAttemptLimiter(maxFailures = 5, windowMs = 15 * 60_000): FailedAttemptLimiter {
  const failures = new Map<string, number[]>();
  const recent = (key: string, nowMs: number) => (failures.get(key) ?? []).filter((at) => nowMs - at < windowMs);
  return {
    isBlocked: (key, nowMs) => recent(key, nowMs).length >= maxFailures,
    recordFailure: (key, nowMs) => void failures.set(key, [...recent(key, nowMs), nowMs]),
    reset: (key) => void failures.delete(key),
  };
}

/** Sliding-window limiter: per user, at most `limit` accepted requests per `windowMs` (OVD-795: 10/min). */
export function createSlidingWindowLimiter(limit = 10, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    tryAcquire(userId, nowMs) {
      const recent = (hits.get(userId) ?? []).filter((at) => nowMs - at < windowMs);
      if (recent.length >= limit) {
        hits.set(userId, recent);
        return false;
      }
      hits.set(userId, [...recent, nowMs]);
      return true;
    },
  };
}
