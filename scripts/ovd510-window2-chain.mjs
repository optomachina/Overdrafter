/**
 * OVD-743 window 2 Jarvis chain rehearsal inside the owned OVD-510 fixture.
 *
 * Runs the run sheet (docs/release/window-2/README.md) in the order pinned by
 * docs/release/window-2/manifest.json, on the reviewed 148 migration baseline:
 *   1. checks every staged file against its manifest sha256;
 *   2. OVD-649 order, forward side, with #702's real prechange pin: with the
 *      observer replacement live the verbatim OVD-558 forward refuses, and the
 *      paired restoration returns the exact baseline catalog;
 *   3. applies every forward in order, recording time, the catalog and the
 *      OVD-602 inventory diff against the checked in expected diff; right after
 *      OVD-558, the OVD-649 order, reverse side, with #702's real post change
 *      pin: the verbatim OVD-558 reverse refuses with the replacement live and
 *      runs after the restoration, and the forward reapplies to the same catalog;
 *   4. runs the OVD-560, OVD-561 and OVD-563 proofs and the compatibility
 *      suites on the full chain, and the out of order reverse refusals;
 *   5. runs every reverse in reverse order, each returning the catalog and the
 *      inventory to their value before that step's forward, ending at the
 *      baseline exactly; then reapplies every forward and checks the catalog.
 * Nothing here reaches a network host or a hosted database.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proveForwardSide, proveReverseSide, refusedWith, sqlError } from "./ovd510-ovd649-window-order.mjs";
import { diffInventories, isEmptyDiff, parseInventory } from "./window-1/ovd602-diff.mjs";

export const MANIFEST = "docs/release/window-2/manifest.json";
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Files of the manifest whose bytes differ from their pinned sha256. */
export function pinDrift(root, manifest) {
  const drift = [];
  for (const step of manifest.jarvis) {
    for (const side of ["forward", "reverse"]) {
      const file = step[side];
      if (sha(readFileSync(join(root, file.path))) !== file.sha256) drift.push(file.path);
    }
  }
  return drift;
}

/** The lead's read only go or no go query, run as both roles on the pristine
 * baseline (before any OVD-558 forward), checked against the manifest pins. */
export function checkReadOnlyDigest({ psql, catalogSql, root }) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const digestSql = readFileSync(join(root, manifest.ovd558.digestQuery), "utf8");
  const before = psql(catalogSql);
  const digestAs = (role) => psql(digestSql, 120_000, role).split("\n").find((line) => /^[0-9a-f]{64}$/.test(line));
  const result = { supabaseAdmin: digestAs("supabase_admin"), postgres: digestAs("postgres") };
  if (result.supabaseAdmin !== manifest.ovd558.prechangeAdminCatalogSha256
      || result.postgres !== manifest.ovd558.prechangePostgresCatalogSha256 || psql(catalogSql) !== before) {
    throw new Error(`window2_read_only_digest_mismatch:${JSON.stringify(result)}`);
  }
  return result;
}

export async function runWindow2Chain(options) {
  const { psql, catalogSql, root, output, save, fixturePrefix, proofs, runSuites, writeExpected } = options;
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const gates = [];
  const gate = (name, pass, detail = "") => {
    gates.push({ name, pass: Boolean(pass), detail });
    if (!pass) throw new Error(`window2_gate_failed:${name}:${detail}`.slice(0, 1500));
  };
  const catalog = () => psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
  const inventorySql = readFileSync(join(root, "scripts/window-1/ovd602-inventory.sql"), "utf8");
  const inventory = () => parseInventory(psql(inventorySql, 120_000).split("\n").find((line) => line.startsWith("{")), "inventory");
  const read = (path) => readFileSync(join(root, path), "utf8");
  const timed = (sql, role) => {
    const started = process.hrtime.bigint();
    psql(sql, 240_000, role);
    return Number((process.hrtime.bigint() - started) / 1_000_000n);
  };
  const refused = (sql, role) => {
    try { psql(sql, 240_000, role); } catch (error) { return error; }
    return null;
  };
  const expectedPath = (name) => join(root, manifest.ovd602.expectedDir, `${name}.json`);
  const checkExpected = (name, diff) => {
    const path = expectedPath(name);
    if (writeExpected) {
      mkdirSync(join(root, manifest.ovd602.expectedDir), { recursive: true });
      writeFileSync(path, `${JSON.stringify(diff, null, 2)}\n`);
    }
    const expected = existsSync(path) ? readFileSync(path, "utf8") : null;
    gate(`ovd602 ${name} diff equals the checked in expected diff`, expected === `${JSON.stringify(diff, null, 2)}\n`);
  };

  // 1. Pins.
  const drift = pinDrift(root, manifest);
  gate("every staged file matches its manifest sha256", drift.length === 0, drift.join(","));
  const steps = manifest.jarvis;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ovd558 = byId.get("ovd-558");
  const replay = byId.get("ovd-649-observer-replay");
  const forward558 = read(ovd558.forward.path);
  const reverse558 = read(ovd558.reverse.path);
  const replacement = read(replay.forward.path);
  const restore = read(replay.reverse.path);

  // Baseline: the reviewed 148 migration catalog, and the OVD-602 inventory
  // compared with the window 1 pin (main e254d032, the production ledger).
  const baseCatalog = catalog();
  const baseInventory = inventory();
  const pin = parseInventory(read(manifest.ovd602.pin), manifest.ovd602.pin);
  const pinDiff = diffInventories(pin, baseInventory);
  writeFileSync(join(output, "window2-ovd602-baseline-vs-window1-pin.json"), `${JSON.stringify(pinDiff, null, 2)}\n`);
  gate("baseline OVD-602 inventory equals the window 1 pin", isEmptyDiff(pinDiff));

  const evidence = { baseCatalogSha256: sha(baseCatalog), readOnlyDigest: options.readOnlyDigest,
    steps: [], reverses: [], reapply: [], proofs: {} };

  const baseSuites = options.mainSuites ? options.mainSuites("window2-main-baseline") : null;
  gate("main suites at baseline leave the catalog unchanged", catalog() === baseCatalog);

  // 2. OVD-649 order, forward side, with the real OVD-558 prechange pin.
  const sql = { forward558, reverse558, replacement, restore };
  const ctx = { ...options, catalog, refused, gate, sql, baseCatalog };
  evidence.windowOrderForward = await proveForwardSide(ctx);

  // 3. Forwards in run sheet order.
  const before = new Map();
  let applied = baseCatalog;
  let appliedInventory = baseInventory;
  for (const step of steps) {
    before.set(step.id, { catalog: applied, inventory: appliedInventory });
    const ms = timed(read(step.forward.path), step.forward.role);
    applied = catalog();
    const afterInventory = inventory();
    const diff = diffInventories(appliedInventory, afterInventory);
    appliedInventory = afterInventory;
    checkExpected(`step-${step.order}-${step.id}`, diff);
    evidence.steps.push({ id: step.id, order: step.order, role: step.forward.role, forwardMs: ms,
      catalogSha256: sha(applied), ovd602Flags: diff.flags });
    if (step.id === "ovd-558") {
      // OVD-649 order, reverse side, with the real OVD-558 post change pin.
      evidence.windowOrderReverse = proveReverseSide(ctx);
    }
  }
  const fullCatalog = applied;
  checkExpected("window-2", diffInventories(pin, appliedInventory));

  // 4. Proofs on the full chain; each rolls back and leaves the catalog.
  const count = (text, marker) => text.split(marker)[1]?.match(/^ok\b/gm)?.length ?? 0;
  const run560 = psql(`${fixturePrefix}\nselect 'ovd560-proof-start';\n${proofs.p560}\nrollback;`, 240_000, "postgres");
  const run561 = psql(`${fixturePrefix}\n${proofs.p561}\nrollback;`, 240_000);
  const run563 = psql(`${fixturePrefix}\n${proofs.p561}\n${proofs.p563}\nrollback;`, 240_000);
  writeFileSync(join(output, "window2-proofs.txt"), `${run560}\n${run561}\n${run563}\n`);
  evidence.proofs = { ovd560: count(run560, "ovd560-proof-start"), ovd561: count(run561, "ovd561-proof-start"),
    ovd563: count(run563, "ovd563-proof-start") };
  gate("OVD-560 proof passes on the full chain", evidence.proofs.ovd560 === 11 && !/not ok/.test(run560), `${evidence.proofs.ovd560}/11`);
  gate("OVD-561 proof passes on the full chain", evidence.proofs.ovd561 === 24 && !/not ok/.test(run561), `${evidence.proofs.ovd561}/24`);
  gate("OVD-563 proof passes on the full chain", evidence.proofs.ovd563 === 25 && !/not ok/.test(run563), `${evidence.proofs.ovd563}/25`);
  evidence.suites = runSuites("window2-full-chain");
  if (baseSuites) {
    const fullSuites = options.mainSuites("window2-main-full-chain");
    const regressed = Object.keys(baseSuites).filter((name) => baseSuites[name].pass && !fullSuites[name]?.pass);
    evidence.mainSuites = { baseline: baseSuites, fullChain: fullSuites, regressed };
    gate("no main pgTAP suite that passes at baseline fails on the full chain", regressed.length === 0, regressed.join(","));
  }
  gate("proofs and suites leave the full chain catalog unchanged", catalog() === fullCatalog);

  // Out of order reverses refuse and change nothing.
  const finalization = byId.get("ovd-561-finalization");
  const early561 = refused(read(finalization.reverse.path), finalization.reverse.role);
  gate("OVD-561 reverse refuses while the pending table exists",
    early561 && refusedWith(early561, "P0001", "ovd561_reverse_requires_pending_reverse_first"), sqlError(early561).message);
  const early558 = refused(reverse558, "supabase_admin");
  gate("OVD-558 reverse refuses while later window 2 steps are applied",
    early558 && refusedWith(early558, "P0001", "ovd558_unknown_postchange_catalog"), sqlError(early558).message);
  gate("refused out of order reverses change nothing", catalog() === fullCatalog);

  // 5. Reverses in reverse order, each back to the state before its forward.
  for (const step of [...steps].reverse()) {
    const ms = timed(read(step.reverse.path), step.reverse.role);
    const prior = before.get(step.id);
    const now = catalog();
    const nowInventory = inventory();
    gate(`${step.id} reverse returns the exact catalog before its forward`, now === prior.catalog);
    gate(`${step.id} reverse returns the OVD-602 inventory before its forward`, isEmptyDiff(diffInventories(prior.inventory, nowInventory)));
    evidence.reverses.push({ id: step.id, order: step.order, role: step.reverse.role, reverseMs: ms, catalogSha256: sha(now) });
  }
  gate("full reverse ends at the baseline catalog exactly", catalog() === baseCatalog);
  gate("full reverse ends at the window 1 OVD-602 pin exactly", isEmptyDiff(diffInventories(pin, inventory())));

  // Reapply.
  for (const step of steps) {
    evidence.reapply.push({ id: step.id, forwardMs: timed(read(step.forward.path), step.forward.role) });
  }
  gate("reapply returns the same full chain catalog", catalog() === fullCatalog);
  const rerun563 = psql(`${fixturePrefix}\n${proofs.p561}\n${proofs.p563}\nrollback;`, 240_000);
  gate("OVD-563 proof passes after reapply", count(rerun563, "ovd563-proof-start") === 25 && !/not ok/.test(rerun563));

  evidence.gates = gates;
  save("window2-chain.json", { status: "passed", manifestSha256: sha(read(MANIFEST)), ...evidence });
  return evidence;
}
