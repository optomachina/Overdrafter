/** OVD-649 window 2 order proof inside the owned OVD-510 fixture. A clone of the
 * post OVD-558/560/561/563 database takes the current-main migration suffix
 * (which creates the OVD-575 function), then the staged observer replacement.
 * The OVD-558 reverse preflight, run verbatim with its pin moved to the clone's
 * own pre-replacement digest, must refuse while the replacement is live and
 * accept again after the paired restoration. The source database is untouched. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRestoreSql, replacementPath, restorePath } from "./native/stop-observer/sql/generate-restore-sql.mjs";

const database = "ovd649_window";
function session({ dockerExecutable, container, password }, role, db, sql) {
  const child = spawn(dockerExecutable, ["exec", "-i", "-e", `PGPASSWORD=${password}`, container,
    "psql", "-U", role, "-d", db, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { stdio: ["pipe", "pipe", "pipe"], timeout: 240_000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.slice(-2000) }));
  });
}

export async function runOvd649WindowOrderProof(options) {
  const { psql, catalogSql, root, suffix, reverse558, sourceCatalog } = options;
  const run = (role, sql) => session(options, role, database, sql);
  const ok = async (role, sql, label) => {
    const result = await run(role, sql);
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    return result.stdout;
  };
  const catalog = async () => (await ok("postgres", catalogSql, "catalog")).split("\n")
    .find((line) => line.startsWith("{"));
  const { sql: restoreSql, pins } = buildRestoreSql();
  if (readFileSync(join(root, restorePath), "utf8") !== restoreSql) throw new Error("ovd649_restore_source_drift");
  const replacementSql = readFileSync(join(root, replacementPath), "utf8");
  const start = reverse558.indexOf("do $ovd558_reverse_preflight$");
  const end = reverse558.indexOf("end $ovd558_reverse_preflight$;");
  if (start < 0 || end < start) throw new Error("ovd649_ovd558_reverse_preflight_marker_drift");
  const preflight = reverse558.slice(start, end + "end $ovd558_reverse_preflight$;".length);
  const pinned = preflight.match(/if actual is distinct from '([0-9a-f]{64})' then\n\s+raise exception 'ovd558_unknown_postchange_catalog/);
  if (!pinned || preflight.split(pinned[1]).length !== 2) throw new Error("ovd649_ovd558_reverse_pin_drift");
  // The verbatim OVD-558 reverse preflight, inside a rolled back transaction.
  const reversePreflight = (pin) => run("supabase_admin",
    `begin;\n${preflight.replace(pinned[1], pin)}\nrollback;`);
  const digestOf = async () => {
    const probe = await reversePreflight("0".repeat(64));
    const digest = probe.stderr.match(/ovd558_unknown_postchange_catalog:([0-9a-f]{64})/)?.[1];
    if (probe.code === 0 || !digest) throw new Error(`ovd649_digest_probe_failed:${probe.stderr}`);
    return digest;
  };

  const preexistingRoles = new Set(psql("select rolname from pg_roles;").split("\n"));
  const cloned = await session(options, "supabase_admin", "template1", `alter database postgres allow_connections false;
    select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres';
    create database ${database} owner postgres template postgres; alter database postgres allow_connections true;`);
  if (cloned.code !== 0) {
    await session(options, "supabase_admin", "template1", "alter database postgres allow_connections true;");
    throw new Error(`ovd649_clone_failed:${cloned.stderr}`);
  }
  let evidence;
  try {
    await ok("postgres", suffix.map((entry) => entry.sql).join("\n"), "current-main suffix");
    const beforeReplacement = await catalog();
    const before = await digestOf();
    const accepted = await reversePreflight(before);
    assert.equal(accepted.code, 0, `ovd558 reverse preflight accepts the pre-replacement catalog: ${accepted.stderr}`);

    // Window 2 forward, last step: the staged replacement.
    await ok("postgres", replacementSql, "staged replacement");
    const withReplacement = await catalog();
    assert.notEqual(withReplacement, beforeReplacement, "replacement changes the catalog");
    const replaced = await digestOf();
    assert.notEqual(replaced, before, "replacement moves the OVD-558 catalog digest");
    const refused = await reversePreflight(before);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /ovd558_unknown_postchange_catalog/,
      "ovd558 reverse refuses while the replacement is live");

    // Window 2 rollback, first step: the paired restoration.
    const repeatable = await run("supabase_admin",
      restoreSql.replace("\nbegin;\n", "\nbegin isolation level repeatable read;\n"));
    assert.notEqual(repeatable.code, 0);
    assert.match(repeatable.stderr, /0A000.*ovd649_restore_read_committed_required|ovd649_restore_read_committed_required/s);
    assert.equal(await catalog(), withReplacement, "refused restoration changes nothing");
    await ok("supabase_admin", restoreSql, "paired restoration");
    const restored = await catalog();
    assert.equal(restored, beforeReplacement, "restoration returns the exact pre-replacement catalog");
    assert.equal(await digestOf(), before, "restoration returns the OVD-558 digest");
    const reaccepted = await reversePreflight(before);
    assert.equal(reaccepted.code, 0, `ovd558 reverse preflight accepts after restoration: ${reaccepted.stderr}`);
    const second = await run("supabase_admin", restoreSql);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /ovd649_restore_unexpected_current_state/);
    assert.equal(await catalog(), beforeReplacement, "second restoration changes nothing");

    // Reapply, then reverse again.
    await ok("postgres", replacementSql, "replacement reapply");
    assert.equal(await catalog(), withReplacement, "reapplied replacement matches the first application");
    await ok("supabase_admin", restoreSql, "restoration after reapply");
    assert.equal(await catalog(), beforeReplacement, "second restoration returns the exact catalog");
    evidence = { preReplacementDigest: before, replacementDigest: replaced,
      replacementBodySha256: pins.replacementBodySha256, originalBodySha256: pins.originalBodySha256,
      suffixMigrations: suffix.length, reverse558PreflightRefusedWithReplacement: true,
      reverse558PreflightAcceptedAfterRestore: true, repeatableReadRestoreRefused: true,
      secondRestoreRefused: true, reapplyThenRestore: true };
  } finally {
    psql(`drop database if exists ${database} with (force);`);
    // Roles are cluster-wide; drop only roles the suffix created in the clone.
    for (const role of psql("select rolname from pg_roles;").split("\n")) {
      if (!preexistingRoles.has(role)) psql(`drop role if exists "${role.replaceAll('"', '""')}";`);
    }
  }
  const after = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
  if (after !== sourceCatalog) throw new Error("ovd649_source_database_catalog_drift");
  return evidence;
}
