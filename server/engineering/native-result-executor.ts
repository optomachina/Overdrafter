/** Structurally compatible with a checked-out node-postgres PoolClient. The
 * caller supplies an already configured, dedicated owner pool; this module
 * neither provisions credentials nor configures the connection or SQL role. A pool
 * lease must be idle (not inside a caller-owned transaction). */
export type NativeOwnerSqlClient = Readonly<{
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: (destroy?: boolean) => void;
}>;
export type NativeOwnerSqlPool = Readonly<{ connect: () => Promise<NativeOwnerSqlClient> }>;

export const NATIVE_FINALIZATION_SQL = Object.freeze({
  load: "select engineering_private.load_native_pending_finalization($1::uuid, $2::uuid) as value",
  persist: "select engineering_private.persist_native_pending_finalization($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::uuid) as value",
  finalize: "select engineering_private.finalize_native_result($1::text, $2::text, $3::text, $4::uuid) as value",
});
export type NativeFinalizationOperation = keyof typeof NATIVE_FINALIZATION_SQL;

/** One bounded, owned READ COMMITTED transaction with one fixed operation.
 * A write is successful only after COMMIT acknowledgement. Driver failures,
 * cancellation and lost COMMIT responses destroy the borrowed connection;
 * they never imply rollback and never cause an automatic retry. Reconciliation
 * is a separate load/exact-replay invocation by the existing finalizer. */
export function createNativeFinalizationExecutor(config: {
  pool: NativeOwnerSqlPool; enabled?: boolean; timeoutMs?: number;
}) {
  const pool = config.pool, enabled = config.enabled === true, timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Invalid native SQL deadline.");
  return async (operation: NativeFinalizationOperation, values: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
    if (!enabled) throw new Error("Native finalization SQL disabled.");
    if (!Object.hasOwn(NATIVE_FINALIZATION_SQL, operation)
      || values.length !== ({ load: 2, persist: 6, finalize: 4 })[operation]) throw new TypeError("Invalid native SQL operation.");
    const parameters = [...values];
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let client: NativeOwnerSqlClient | undefined, released = false, committed = false, writeStarted = false;
    const release = (destroy: boolean) => {
      if (client && !released) { released = true; client.release(destroy); }
    };
    const interrupted = () => new Error(writeStarted
      ? "Native SQL write outcome unknown; explicit reconciliation required."
      : "Native SQL operation interrupted before write dispatch.");
    const ensure = () => {
      if (performance.now() >= deadline) controller.abort();
      if (controller.signal.aborted) throw interrupted();
    };
    const bounded = <T>(start: () => Promise<T>, discard?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
      const stopped = () => { controller.signal.removeEventListener("abort", stopped); reject(interrupted()); };
      controller.signal.addEventListener("abort", stopped, { once: true });
      try {
        ensure();
        start().then(value => {
          try { ensure(); resolve(value); } catch (error) { discard?.(value); reject(error); }
        }, reject).catch(reject).finally(() => controller.signal.removeEventListener("abort", stopped));
        ensure();
      } catch (error) { controller.signal.removeEventListener("abort", stopped); reject(error); }
    });
    try {
      client = await bounded(() => pool.connect(), late => late.release(true));
      // No SET ROLE, credential lookup, dynamic identifiers or caller SQL.
      await bounded(() => client!.query("begin isolation level read committed"));
      // Do not inherit asynchronous commit from a pool/session default: the
      // durable envelope must be WAL-flushed before finalization can begin.
      await bounded(() => client!.query("set local synchronous_commit = 'on'"));
      await bounded(() => client!.query("set local statement_timeout = '30s'"));
      await bounded(() => client!.query("set local lock_timeout = '5s'"));
      const result = await bounded(() => {
        writeStarted = operation !== "load";
        return client!.query(NATIVE_FINALIZATION_SQL[operation], parameters);
      });
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1
        || typeof result.rows[0] !== "object" || result.rows[0] === null
        || !Object.hasOwn(result.rows[0], "value")) throw new TypeError("Invalid native SQL result.");
      const value = (result.rows[0] as { value: unknown }).value;
      await bounded(() => client!.query("commit"));
      committed = true;
      return value;
    } catch (cause) {
      throw new Error(writeStarted ? "Native SQL write outcome unknown; explicit reconciliation required."
        : "Native SQL operation failed before write dispatch.", { cause });
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort();
      // Destroy any non-acknowledged transaction instead of placing a possibly
      // still-running query/transaction back in the pool or queuing ROLLBACK.
      release(!committed);
    }
  };
}
