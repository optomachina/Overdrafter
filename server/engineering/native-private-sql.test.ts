import { describe, expect, it, vi } from "vitest";
import { createNativePrivateSql } from "./native-private-sql";
import type { PrivateArtifactSql } from "./native-artifact-repository";
const options = () => ({ signal: new AbortController().signal, timeoutMs: 30000 as const, isolation: "read committed" as const });
function setup(config: { timeoutMs?: number; query?: (text: string) => Promise<{ rows: unknown[] }> } = {}) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => config.query ? config.query(text) : { rows: [{ id: "synthetic" }] });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  const sql = createNativePrivateSql({ pool: { connect }, enabled: true, timeoutMs: config.timeoutMs });
  return { sql, query, release, connect };
}
describe("private SQL driver", () => {
  it("is default-off before pool acquisition", async () => {
    const connect = vi.fn();
    await expect(createNativePrivateSql({ pool: { connect } }).query("select 1", [], options())).rejects.toThrow("disabled");
    expect(connect).not.toHaveBeenCalled();
  });
  it("owns one durable READ COMMITTED lease and returns only after commit", async () => {
    const f = setup(); const result = await f.sql.transaction(async sql => {
      await sql.query("select $1", ["first"], options());
      return sql.query("select $1", ["second"], options());
    }, options());
    expect(result).toEqual([{ id: "synthetic" }]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.map(call => call[0])).toEqual(["begin isolation level read committed", "set local synchronous_commit = 'on'", "set local statement_timeout = '30s'", "set local lock_timeout = '5s'", "select $1", "select $1", "commit"]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("snapshots parameters before waiting for the pool", async () => {
    let grant!: (value: Awaited<ReturnType<ReturnType<typeof setup>["connect"]>>) => void;
    const f = setup(), parameters = [{ x: "original" }];
    const connect = vi.fn(() => new Promise<Awaited<ReturnType<typeof f.connect>>>(resolve => { grant = resolve; }));
    const call = createNativePrivateSql({ pool: { connect }, enabled: true }).query("select $1", parameters, options());
    parameters[0].x = "changed"; grant({ query: f.query, release: f.release }); await call;
    expect(f.query).toHaveBeenCalledWith("select $1", [{ x: "original" }]);
  });
  it("destroys late acquired clients without dispatch", async () => {
    let grant!: (value: Awaited<ReturnType<ReturnType<typeof setup>["connect"]>>) => void;
    const f = setup(), controller = new AbortController();
    const connect = vi.fn(() => new Promise<Awaited<ReturnType<typeof f.connect>>>(resolve => { grant = resolve; }));
    const call = createNativePrivateSql({ pool: { connect }, enabled: true }).query("select 1", [], { ...options(), signal: controller.signal });
    controller.abort(); await expect(call).rejects.toThrow(); grant({ query: f.query, release: f.release });
    await Promise.resolve(); await Promise.resolve();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.query).not.toHaveBeenCalled();
  });
  it("revokes callback queries before dispatching a deferred COMMIT", async () => {
    let commitStarted!: () => void, finishCommit!: (value: { rows: unknown[] }) => void;
    const pendingCommit = new Promise<{ rows: unknown[] }>(resolve => { finishCommit = resolve; });
    const started = new Promise<void>(resolve => { commitStarted = resolve; });
    const f = setup({ query: async text => {
      if (text === "commit") { commitStarted(); return pendingCommit; }
      return { rows: [] };
    } });
    let lease!: PrivateArtifactSql;
    const transaction = f.sql.transaction(async sql => { lease = sql; await sql.query("select intended_write()", [], options()); return "done"; }, options());
    await started;
    await expect(lease.query("select late_write()", [], options())).rejects.toThrow("lease closed");
    expect(f.query.mock.calls.some(call => call[0] === "select late_write()")).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    finishCommit({ rows: [] }); await expect(transaction).resolves.toBe("done");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("never retries an unknown commit and destroys its connection", async () => {
    const f = setup({ query: async text => { if (text === "commit") throw Error("lost ack"); return { rows: [] }; } });
    await expect(f.sql.query("select write_function()", [], options())).rejects.toThrow("outcome unknown");
    expect(f.query.mock.calls.filter(call => call[0] === "commit")).toHaveLength(1);
    expect(f.query.mock.calls.some(call => call[0] === "rollback")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("bounds a hung query and prevents continuation with a retained lease", async () => {
    const f = setup({ timeoutMs: 10, query: async text => text === "select hang" ? new Promise(() => {}) : { rows: [] } });
    let lease!: PrivateArtifactSql;
    await expect(f.sql.transaction(async sql => { lease = sql; await sql.query("select hang", [], options()); }, options())).rejects.toThrow("unknown");
    await expect(lease.query("select late", [], options())).rejects.toThrow();
    expect(f.query.mock.calls.some(call => ["commit", "select late"].includes(call[0]))).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("rejects nested or concurrent use instead of queuing work", async () => {
    const f = setup();
    await expect(f.sql.transaction(sql => sql.transaction(async () => 1, options()), options())).rejects.toThrow();
    expect(f.query.mock.calls.some(call => call[0] === "commit")).toBe(false);
    const second = setup({ query: async text => text === "select hang" ? new Promise(() => {}) : { rows: [] } });
    await expect(second.sql.transaction(async sql => Promise.all([
      sql.query("select hang", [], options()), sql.query("select queued", [], options()),
    ]), options())).rejects.toThrow();
    expect(second.query.mock.calls.some(call => call[0] === "select queued")).toBe(false);
  });
});
