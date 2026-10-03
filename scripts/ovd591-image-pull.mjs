/** Retry only the observed public ECR throttle, without changing image or registry.
 * Docker 29 daemons report it without the legacy "Error response from daemon: " prefix. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const BACKOFF = Object.freeze([10_000, 20_000]);
const BUDGET_MS = 300_000;
export function isPublicEcrThrottle(result) {
  return Number.isInteger(result.status) && result.status > 0 && !result.failure
    && /^(?:Error response from daemon: )?toomanyrequests: Rate exceeded$/.test(result.stderr.trim());
}

/** call retains each raw result; save retains classification and bounded retry decisions. */
export async function pullFixtureImage({ call, image, label, signal, deadline = Infinity, save },
  { now = Date.now, wait = delay } = {}) {
  assert.match(image, /^public\.ecr\.aws\/supabase\/[a-z-]+:[a-zA-Z0-9.-]+$/);
  assert.match(label, /^[a-z-]+$/);
  const expires = Math.min(deadline, now() + BUDGET_MS);
  const receipt = { image, status: 'running', budgetMs: BUDGET_MS, attempts: [] };
  const check = () => {
    assert(!signal?.aborted, `${label} cancelled`);
    assert(now() < expires, `${label} deadline exceeded`);
  };
  try {
    for (let attempt = 1; attempt <= BACKOFF.length + 1; attempt++) {
      check();
      const timeout = expires - now();
      const result = await call('docker', ['pull', image], { timeout, allowFailure: true,
        label: attempt === 1 ? label : `${label}-attempt-${attempt}` });
      const entry = { attempt, timeoutMs: timeout, status: result.status, failure: result.failure ?? null,
        rateLimited: isPublicEcrThrottle(result) };
      receipt.attempts.push(entry); save(receipt);
      check();
      if (!result.failure && result.status === 0) { receipt.status = 'passed'; return result; }
      assert(entry.rateLimited && attempt <= BACKOFF.length, `${label} command failed`);
      const waitMs = BACKOFF[attempt - 1];
      assert(now() + waitMs < expires, `${label} deadline exceeded`);
      entry.backoffMs = waitMs; save(receipt);
      await wait(waitMs, undefined, { signal });
    }
  } finally {
    if (receipt.status !== 'passed') receipt.status = 'failed';
    save(receipt);
  }
}
