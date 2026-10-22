import { isEntryPoint } from "./lib/entry-point.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "docs/release/ovd-635-ledger-152-manifest.json";
export const PRE_CHECK_PATH = "docs/release/ovd-635-ledger-152-pre-check.sql";
export const MIGRATION_ROOT = "supabase/migrations";

const hash = (algorithm, contents) => createHash(algorithm).update(contents).digest("hex");

/**
 * Checks that the frozen OVD-635 manifest is an exact ordered prefix of the
 * repository migrations, byte for byte, and that the owner pre-check SQL lists
 * exactly the manifest versions. Later migrations may follow the prefix.
 */
export function verifyOvd635LedgerManifest(root) {
  const violations = [];
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
  const entries = manifest.migrations ?? [];
  const files = readdirSync(path.join(root, MIGRATION_ROOT)).filter((name) => name.endsWith(".sql")).sort();

  if (manifest.format !== "ovd635.ledger-manifest.v1") violations.push("unexpected manifest format");
  if (manifest.count !== entries.length) violations.push("count does not match the migration entries");
  if (manifest.head !== entries.at(-1)?.version) violations.push("head is not the last migration version");
  const versions = entries.map((entry) => entry.version);
  if (manifest.versionListMd5 !== hash("md5", versions.join("\n"))) violations.push("versionListMd5 drifted");

  entries.forEach((entry, index) => {
    if (files[index] !== entry.file) {
      violations.push(`position ${index + 1}: expected ${entry.file}, found ${files[index] ?? "nothing"}`);
      return;
    }
    if (!entry.file.startsWith(`${entry.version}_`)) violations.push(`${entry.file}: version mismatch`);
    const actual = hash("sha256", readFileSync(path.join(root, MIGRATION_ROOT, entry.file)));
    if (actual !== entry.sha256) violations.push(`${entry.file}: sha256 drifted`);
  });

  const preCheck = readFileSync(path.join(root, PRE_CHECK_PATH), "utf8");
  const listed = [...preCheck.matchAll(/^\s+\('(\d{14})'\)/gm)].map((match) => match[1]);
  if (listed.join("\n") !== versions.join("\n")) violations.push("pre-check versions differ from the manifest");
  for (const expected of [`count ${manifest.count}`, `head ${manifest.head}`, manifest.versionListMd5]) {
    if (!preCheck.includes(expected)) violations.push(`pre-check header does not state ${expected}`);
  }
  return violations;
}

if (isEntryPoint(import.meta.url)) {
  const violations = verifyOvd635LedgerManifest(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("OVD-635 ledger manifest matches the repository migrations.");
}
