// OVD-743 window 2 packet checks for the portable node lane (no database).
// Fails when the staged observer replacement and its generated restoration
// drift apart, when a staged file drifts from its manifest pin, when the
// OVD-558 SQL drifts from its generator, or when the run sheet order drifts
// from the manifest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { refusedWith, sqlError } from "./ovd510-ovd649-window-order.mjs";
import { MANIFEST, pinDrift } from "./ovd510-window2-chain.mjs";
import { buildRestoreSql, replacementPath, restorePath } from "./native/stop-observer/sql/generate-restore-sql.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read(MANIFEST));
const node = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });

test("the restore generator --check passes on the committed pair", () => {
  const run = node(["scripts/native/stop-observer/sql/generate-restore-sql.mjs", "--check"]);
  assert.equal(run.status, 0, run.stderr);
});

test("a changed replacement no longer matches the committed restoration", () => {
  const committed = read(restorePath);
  const changedBody = buildRestoreSql((path) => path === replacementPath
    ? read(path).replace("return v_id;\nend;", () => "return v_id; -- drift\nend;") : read(path));
  assert.notEqual(changedBody.sql, committed);
  const changedHeader = buildRestoreSql((path) => path === replacementPath
    ? read(path).replace("set local lock_timeout = '10s';", "set local lock_timeout = '11s';") : read(path));
  assert.notEqual(changedHeader.sql, committed, "the restoration pins the whole replacement file");
  assert.throws(() => buildRestoreSql((path) => path === replacementPath
    ? read(path).replace(/commit;\n$/, "") : read(path)), /ovd649_replacement_transaction_shape_drift/);
});

test("the OVD-558 SQL equals its generator output at the manifest post change pin", () => {
  const run = node(["scripts/ovd510-generate-migration-sql.mjs", manifest.ovd558.postchangeCatalogSha256, "--check"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(read("docs/release/ovd-558-verifier-authority-forward.sql"),
    new RegExp(`if actual is distinct from '${manifest.ovd558.prechangeCatalogSha256}' then`));
  assert.match(read("docs/release/ovd-558-verifier-authority-reverse.sql"),
    new RegExp(`if actual is distinct from '${manifest.ovd558.postchangeCatalogSha256}' then`));
});

test("OVD-558 runs as postgres and never acts as a platform role", () => {
  for (const path of ["docs/release/ovd-558-verifier-authority-forward.sql", "docs/release/ovd-558-verifier-authority-reverse.sql"]) {
    const sql = read(path);
    assert.match(sql, /if current_user <> 'postgres'/);
    assert.doesNotMatch(sql, /supabase_admin|rolsuper from pg_roles where rolname = current_user/);
    assert.doesNotMatch(sql, /set role "?supabase_storage_admin|for role supabase_storage_admin/i);
  }
  assert.equal(manifest.ovd558.runnerRole, "postgres");
  assert.ok(manifest.jarvis.every((step) => step.forward.role === "postgres" && step.reverse.role === "postgres"));
});

test("the verifier function sets in the manifest equal the generator and the forward pins both", async () => {
  const generator = await import("./ovd510-generate-migration-sql.mjs");
  assert.deepEqual(manifest.ovd558.verifierAppFunctions, generator.verifierAppFunctions);
  assert.deepEqual(manifest.ovd558.anonStorageFunctions, generator.anonStorageFunctions);
  const forward = read("docs/release/ovd-558-verifier-authority-forward.sql");
  for (const name of [...generator.verifierAppFunctions, ...generator.anonStorageFunctions]) {
    assert.ok(forward.includes(`'${name}'`), name);
  }
  assert.match(forward, /raise exception 'ovd558_storage_anon_functions_changed:%'/);
  assert.match(forward, /raise exception 'ovd558_verifier_storage_table_exceeds_anon'/);
});

test("every staged window 2 file matches its manifest sha256", () => {
  assert.deepEqual(pinDrift(root, manifest), []);
});

test("every staged forward and reverse refuses anything but READ COMMITTED, then takes (510, 2) first", () => {
  for (const step of manifest.jarvis) {
    for (const side of ["forward", "reverse"]) {
      const sql = read(step[side].path).replace(/--[^\n]*/g, "");
      const begin = sql.indexOf("\nbegin;\n");
      const isolation = sql.search(/current_setting\('transaction_isolation'\) ?<> ?'read committed'/);
      const lock = sql.indexOf("select pg_advisory_xact_lock(510, 2);");
      const firstRelation = sql.search(/\n(lock table|create |alter |drop |do \$preflight\$|do \$ovd558_preflight\$|do \$ovd558_reverse_lock\$|do \$ovd649_restore\$)/);
      assert.ok(begin >= 0 && begin < isolation && isolation < lock && lock < firstRelation,
        `${step[side].path}: begin ${begin}, isolation ${isolation}, lock ${lock}, first relation ${firstRelation}`);
    }
  }
});

test("the run sheet lists the manifest order forward and exactly reversed", () => {
  const readme = read("docs/release/window-2/README.md");
  const paths = (section) => {
    const body = readme.split(`<!-- ${section} -->`)[1];
    assert.ok(body, `run sheet section ${section}`);
    return [...body.split("<!-- end -->")[0].matchAll(/^\| *\d+ *\| *`([^`]+)`/gm)].map((m) => m[1]);
  };
  const forward = manifest.jarvis.map((step) => step.forward.path);
  const reverse = [...manifest.jarvis].reverse().map((step) => step.reverse.path);
  assert.deepEqual(paths("forward-order"), forward);
  assert.deepEqual(paths("reverse-order"), reverse);
});

test("every OVD-558 generator command in the run sheet uses the manifest post change pin", () => {
  const pins = [...read("docs/release/window-2/README.md").matchAll(/ovd510-generate-migration-sql\.mjs ([0-9a-f]{64})/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, "run sheet generator check");
  for (const pin of pins) assert.equal(pin, manifest.ovd558.postchangeCatalogSha256);
});

test("a refusal counts only with its SQLSTATE", () => {
  const verbose = "psql:<stdin>:12: ERROR:  0A000: ovd649_restore_read_committed_required\nCONTEXT: x";
  assert.equal(refusedWith(verbose, "0A000", "ovd649_restore_read_committed_required"), true);
  assert.equal(refusedWith(verbose.replace("0A000", "P0001"), "0A000", "ovd649_restore_read_committed_required"), false);
  assert.equal(refusedWith("ERROR: ovd649_restore_read_committed_required", "0A000", "ovd649_restore_read_committed_required"), false);
  assert.equal(refusedWith(null, "0A000", "x"), false);
  assert.deepEqual(sqlError(verbose), { sqlstate: "0A000", message: "ovd649_restore_read_committed_required" });
});

test("the read only digest query equals the OVD-558 forward preflight digest query", () => {
  const forward = read("docs/release/ovd-558-verifier-authority-forward.sql");
  const open = "  select digest_value into actual from (";
  const start = forward.indexOf(open) + open.length;
  const query = forward.slice(start, forward.indexOf(") as digest(digest_value);", start));
  const digest = read("docs/release/window-2/ovd558-catalog-digest.sql");
  assert.ok(digest.includes(`\nbegin read only;\nset local search_path = pg_catalog;\n${query};\nrollback;\n`));
  // The forward takes the same digest under the same fixed search_path.
  assert.ok(forward.includes(`perform set_config('search_path', 'pg_catalog', true);\n  select digest_value into actual from (${query})`));
  // Outside string literals and comments, no statement can write.
  assert.doesNotMatch(digest.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, "''"),
    /\b(insert|update|delete|create|alter|drop|grant|revoke|lock|commit)\b/i);
});

test("the restore check refuses URLs that libpq could send to a remote host", async () => {
  const { isLocalTarget } = await import("./window-1/restore-check.mjs");
  assert.equal(isLocalTarget("postgresql://postgres:postgres@127.0.0.1:54322/postgres"), true);
  assert.equal(isLocalTarget("postgresql:///postgres?host=/tmp"), true);
  assert.equal(isLocalTarget("postgresql://localhost/postgres?host=localhost&host=db.example.com"), false);
  assert.equal(isLocalTarget("postgresql:///postgres?host=/tmp,db.example.com"), false);
  assert.equal(isLocalTarget("postgresql://localhost/postgres?host=localhost,db.example.com"), false);
  assert.equal(isLocalTarget("postgresql://db.example.com/postgres"), false);
});
