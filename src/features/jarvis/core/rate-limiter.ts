export interface RateLimiter {
  /** Records a request and returns true when it fits the window; a refusal records nothing. */
  tryAcquire(userId: string, nowMs: number): boolean;
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
