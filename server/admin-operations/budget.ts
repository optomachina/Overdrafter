const checks = new WeakMap<AbortSignal, () => void>();
export function checkBudget(signal: AbortSignal) { checks.get(signal)?.(); signal.throwIfAborted(); }

/** Wall-clock labels never control I/O budgets. Pending and settled work share monotonic expiry. */
export async function withinBudget<T>(start: (signal: AbortSignal) => Promise<T>, milliseconds: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const until = performance.now() + milliseconds;
  const abort = () => controller.abort();
  const check = () => {
    if (parent) checkBudget(parent);
    if (performance.now() >= until) abort();
    controller.signal.throwIfAborted();
  };
  checks.set(controller.signal, check);
  const timer = setTimeout(abort, milliseconds);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    return await new Promise<T>((resolve, reject) => {
      const stopped = () => reject(new Error("unavailable"));
      controller.signal.addEventListener("abort", stopped, { once: true });
      void (async () => {
        try { check(); const result = await start(controller.signal); check(); resolve(result); }
        catch (error) { reject(error); }
        finally { controller.signal.removeEventListener("abort", stopped); }
      })();
    });
  } finally {
    clearTimeout(timer); parent?.removeEventListener("abort", abort); abort(); checks.delete(controller.signal);
  }
}

export async function readBoundedJson(response: Response, signal: AbortSignal, maximum = 262_144): Promise<unknown> {
  if (!response.body || response.redirected) { void response.body?.cancel().catch(() => undefined); throw new Error("unavailable"); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body.cancel().catch(() => undefined); throw new Error("unavailable"); }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0, chunks = 0;
  const bytes: Uint8Array[] = [];
  try {
    while (true) {
      checkBudget(signal);
      const next = await reader.read();
      checkBudget(signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || !next.value.length || ++chunks > 4096) throw new Error("unavailable");
      size += next.value.length;
      if (size > maximum) throw new Error("unavailable");
      bytes.push(next.value);
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of bytes) { buffer.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}
