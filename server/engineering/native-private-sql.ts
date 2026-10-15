import type { PrivateArtifactSql } from "./native-artifact-repository";
import type { NativeOwnerSqlClient, NativeOwnerSqlPool } from "./native-result-executor";

/** Trusted SQL capability over an already configured dedicated owner pool. No
 * connection strings, role switching, retries, or public RPCs. Never expose the
 * query method to worker input. A lease must arrive idle. */
export function createNativePrivateSql(config: {
  pool: NativeOwnerSqlPool; enabled?: boolean; timeoutMs?: number;
}): PrivateArtifactSql {
  const pool = config.pool, enabled = config.enabled === true, timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Invalid private SQL deadline.");
  const transaction: PrivateArtifactSql["transaction"] = async (work, options) => {
    if (!enabled) throw new Error("Private SQL disabled.");
    if (options.isolation !== "read committed" || options.timeoutMs !== 30000) throw new TypeError("Invalid private SQL options.");
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    let client: NativeOwnerSqlClient | undefined, committed = false, active = true, busy = false, dispatched = false, acceptingQueries = true;
    const failure = () => new Error(dispatched ? "Private SQL outcome unknown; explicit reconciliation required." : "Private SQL interrupted before operation.");
    const ensure = () => {
      if (performance.now() >= deadline) abort();
      if (!active || controller.signal.aborted) throw failure();
    };
    const bounded = <T>(start: () => Promise<T>, discard?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
      const stop = () => { controller.signal.removeEventListener("abort", stop); reject(failure()); };
      controller.signal.addEventListener("abort", stop, { once: true });
      try {
        ensure();
        start().then(value => {
          try { ensure(); resolve(value); } catch (error) { discard?.(value); reject(error); }
        }, reject).finally(() => controller.signal.removeEventListener("abort", stop)).catch(reject);
      } catch (error) { controller.signal.removeEventListener("abort", stop); reject(error); }
    });
    const query: PrivateArtifactSql["query"] = async (text, values, queryOptions) => {
      ensure();
      if (!acceptingQueries) throw new Error("Private SQL callback lease closed.");
      if (busy || queryOptions.timeoutMs !== 30000 || queryOptions.signal.aborted) { abort(); throw failure(); }
      // Snapshot before the first await; values cannot change while pool/locks wait.
      const parameters = structuredClone([...values]);
      const queryAbort = () => abort();
      queryOptions.signal.addEventListener("abort", queryAbort, { once: true });
      busy = true;
      try {
        const result = await bounded(() => { dispatched = true; return client!.query(text, parameters); });
        if (!result || !Array.isArray(result.rows) || result.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw failure();
        return structuredClone(result.rows) as Record<string, unknown>[];
      } catch (error) { abort(); throw error; }
      finally { busy = false; queryOptions.signal.removeEventListener("abort", queryAbort); }
    };
    try {
      client = await bounded(() => pool.connect(), late => late.release(true));
      await bounded(() => client!.query("begin isolation level read committed"));
      await bounded(() => client!.query("set local synchronous_commit = 'on'"));
      await bounded(() => client!.query("set local statement_timeout = '30s'"));
      await bounded(() => client!.query("set local lock_timeout = '5s'"));
      const lease: PrivateArtifactSql = Object.freeze({ query, transaction: async () => { abort(); throw new Error("Nested private SQL transaction denied."); } });
      const value = await bounded(() => work(lease));
      // Revoke the callback capability before COMMIT can be dispatched. A
      // retained lease must never queue a new autocommitted query behind it.
      acceptingQueries = false;
      if (busy) { abort(); throw failure(); }
      await bounded(() => client!.query("commit"));
      committed = true;
      return value;
    } catch (cause) { throw new Error(dispatched ? "Private SQL outcome unknown; explicit reconciliation required." : "Private SQL operation failed before dispatch.", { cause }); }
    finally {
      acceptingQueries = false; active = false; clearTimeout(timer); options.signal.removeEventListener("abort", abort); abort();
      // Destroy unacknowledged transactions: queuing ROLLBACK after a hung query
      // cannot safely certify rollback or make the connection reusable.
      client?.release(!committed);
    }
  };
  return Object.freeze({ transaction, query: (text, values, options) => {
    const parameters = structuredClone([...values]);
    return transaction(sql => sql.query(text, parameters, options), { ...options, isolation: "read committed" });
  },
  });
}
