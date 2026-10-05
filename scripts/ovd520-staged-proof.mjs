/** Failed native attempt terminal proof, run inside the owned disposable replay fixture. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const expectedAssertions = 10;
export const evidenceBoundary = "synthetic disposable SQL; not native, Windows or production evidence";

export function runOvd520StagedProof({ psql, catalogSql, root, output, save, fixturePrefix, proof561, proof563,
  catalog563, fixtureId, sourceRevision }) {
  const proof520 = readFileSync(join(root, "docs/release/ovd-520-staged-proof.sql"), "utf8");
  const result = psql(`${fixturePrefix}\n${proof561}\n${proof563}\n${proof520}\nrollback;`, 240_000);
  writeFileSync(join(output, "ovd520-behavior.txt"), `${result}\n`);
  const assertions = result.split("ovd520-proof-start")[1]?.match(/^ok\b/gm)?.length ?? 0;
  if (/not ok|Looks like you failed/i.test(result) || assertions !== expectedAssertions) {
    throw new Error(`ovd520_behavior_failed:${assertions}/${expectedAssertions}`);
  }
  if (psql(catalogSql).split("\n").find((line) => line.startsWith("{")) !== catalog563) {
    throw new Error("ovd520_behavior_rollback_catalog_drift");
  }
  const evidence = { status: "passed", fixtureId, sourceRevision,
    proofSha256: createHash("sha256").update(proof520).digest("hex"), assertions,
    syntheticOnly: true, evidenceBoundary };
  save("ovd520-staged-proof.json", evidence);
  return evidence;
}
