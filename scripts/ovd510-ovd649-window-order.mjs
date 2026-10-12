/** OVD-649 window 2 order proof with #702's real pins, inside the owned OVD-510
 * fixture on the reviewed 148 migration baseline (OVD-575 and OVD-576 included).
 * Called by scripts/ovd510-window2-chain.mjs at the two moments the OVD-558
 * pins are read:
 *  - forward side, on the baseline: with the observer replacement live the
 *    verbatim OVD-558 forward refuses (its pinned prechange catalog), and the
 *    paired restoration returns the exact baseline catalog;
 *  - reverse side, right after the OVD-558 forward: with the replacement live
 *    the verbatim OVD-558 reverse refuses (its pinned post change catalog);
 *    after the restoration it runs, and the forward reapplies to the same catalog.
 * No pin is moved or substituted. Each refusal must carry its SQLSTATE. */
import { spawn } from "node:child_process";

/** One SQLSTATE and message from a psql failure; VERBOSITY=verbose prints both. */
export function sqlError(error) {
  const match = String(error).match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);
  return match ? { sqlstate: match[1], message: match[2].trim() } : { sqlstate: null, message: String(error).slice(0, 400) };
}

/** True only when the failure carries exactly this SQLSTATE and this message prefix. */
export function refusedWith(error, sqlstate, message) {
  if (!error) return false;
  const parsed = sqlError(error);
  return parsed.sqlstate === sqlstate && parsed.message.startsWith(message);
}

const repeatableRead = (sql) => {
  if (sql.split("\nbegin;\n").length !== 2) throw new Error("ovd649_transaction_marker_drift");
  return sql.replace("\nbegin;\n", "\nbegin isolation level repeatable read;\n");
};

function session({ dockerExecutable, container, password }, role, sql) {
  const child = spawn(dockerExecutable, ["exec", "-i", "-e", `PGPASSWORD=${password}`, container,
    "psql", "-U", role, "-d", "postgres", "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  child.stdin.end(sql);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: stderr.slice(-2000) }));
  });
}

/** Forward side, on the baseline catalog. */
export async function proveForwardSide(ctx) {
  const { psql, catalog, refused, gate, sql } = ctx;
  const base = catalog();
  const rrReplacement = refused(repeatableRead(sql.replacement), "postgres");
  gate("observer replacement refuses REPEATABLE READ with 0A000",
    refusedWith(rrReplacement, "0A000", "ovd649_replay_read_committed_required"), sqlError(rrReplacement).message);
  gate("refused replacement changes nothing", catalog() === base);
  // The replacement waits on a held (510, 2) lock, as every window 2 script does.
  const holder = session(ctx, "postgres", "begin; select pg_advisory_xact_lock(510, 2); select pg_sleep(3); commit;");
  // Start timing only once the holder has the lock, however slow its exec start.
  const lockDeadline = Date.now() + 10_000;
  while (psql("select count(*) from pg_locks where locktype = 'advisory' and classid = 510 and objid = 2 and objsubid = 2 and granted;",
    10_000, "postgres") !== "1") {
    if (Date.now() > lockDeadline) throw new Error("ovd649_holder_lock_not_observed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const started = Date.now();
  psql(sql.replacement, 60_000, "postgres");
  const waitedMs = Date.now() - started;
  gate("observer replacement waits on a held (510, 2) lock", (await holder).code === 0 && waitedMs >= 1500, `${waitedMs} ms`);
  gate("replacement changes the catalog", catalog() !== base);
  const forwardRefusal = refused(sql.forward558, "supabase_admin");
  gate("verbatim OVD-558 forward refuses while the replacement is live (real prechange pin)",
    refusedWith(forwardRefusal, "P0001", "ovd558_prechange_catalog_mismatch"), sqlError(forwardRefusal).message);
  const rrRestore = refused(repeatableRead(sql.restore), "postgres");
  gate("restoration refuses REPEATABLE READ with 0A000",
    refusedWith(rrRestore, "0A000", "ovd649_restore_read_committed_required"), sqlError(rrRestore).message);
  psql(sql.restore, 60_000, "postgres");
  gate("restoration returns the exact baseline catalog", catalog() === base);
  const second = refused(sql.restore, "postgres");
  gate("a second restoration refuses and changes nothing",
    refusedWith(second, "P0001", "ovd649_restore_unexpected_current_state") && catalog() === base, sqlError(second).message);
  return { replacementWaitedMs: waitedMs, ovd558ForwardRefusal: sqlError(forwardRefusal) };
}

/** Reverse side, on the catalog right after the OVD-558 forward. */
export function proveReverseSide(ctx) {
  const { psql, catalog, refused, gate, sql, baseCatalog } = ctx;
  const post = catalog();
  psql(sql.replacement, 60_000, "postgres");
  const reverseRefusal = refused(sql.reverse558, "supabase_admin");
  gate("verbatim OVD-558 reverse refuses while the replacement is live (real post change pin)",
    refusedWith(reverseRefusal, "P0001", "ovd558_unknown_postchange_catalog"), sqlError(reverseRefusal).message);
  psql(sql.restore, 60_000, "postgres");
  gate("restoration returns the exact post OVD-558 catalog", catalog() === post);
  psql(sql.reverse558, 240_000, "supabase_admin");
  gate("verbatim OVD-558 reverse runs after the restoration and returns the baseline", catalog() === baseCatalog);
  psql(sql.forward558, 240_000, "supabase_admin");
  gate("OVD-558 forward reapplies to the same post change catalog", catalog() === post);
  return { ovd558ReverseRefusal: sqlError(reverseRefusal), reverseAfterRestore: true };
}
