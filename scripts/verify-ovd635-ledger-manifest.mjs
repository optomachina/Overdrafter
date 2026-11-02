import { isEntryPoint } from "./lib/entry-point.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "docs/release/ovd-635-ledger-161-manifest.json";
export const PRE_CHECK_PATH = "docs/release/ovd-635-ledger-161-pre-check.sql";
export const SUFFIX_PATH = "docs/release/ovd-635-next-window-suffix-manifest.json";
export const AUTHORIZATION_PATH = "docs/release/ovd-635-next-window-authorization.template.json";
export const MIGRATION_ROOT = "supabase/migrations";

const hash = (algorithm, contents) => createHash(algorithm).update(contents).digest("hex");

/**
 * Checks that the frozen OVD-635 manifest is an exact ordered prefix of the
 * repository migrations, byte for byte, and that the owner pre-check SQL lists
 * exactly the manifest versions. The next-window suffix manifest must follow
 * the prefix immediately, byte for byte, with its rollbacks and ledger states.
 * Later migrations may follow the suffix, unless `exact` is set: then the
 * repository must hold exactly the baseline plus the suffix, which is the
 * deploy-commit check before `supabase migration up` in the window.
 */
export function verifyOvd635LedgerManifest(root, { exact = false } = {}) {
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
  violations.push(...verifySuffix(root, manifest, files, exact));
  return violations;
}

function verifySuffix(root, manifest, files, exact) {
  const violations = [];
  const suffix = JSON.parse(readFileSync(path.join(root, SUFFIX_PATH), "utf8"));
  const { baseline = {}, migrations = [], states = [] } = suffix;
  if (suffix.format !== "ovd635.suffix-manifest.v1") violations.push("suffix: unexpected manifest format");
  if (baseline.count !== manifest.count || baseline.head !== manifest.head || baseline.versionListMd5 !== manifest.versionListMd5) {
    violations.push("suffix: baseline does not match the ledger manifest");
  }
  const versions = manifest.migrations.map((entry) => entry.version);
  migrations.forEach((entry, index) => {
    const position = manifest.count + index;
    if (files[position] !== entry.file) {
      violations.push(`suffix position ${index + 1}: expected ${entry.file}, found ${files[position] ?? "nothing"}`);
      return;
    }
    const bytes = readFileSync(path.join(root, MIGRATION_ROOT, entry.file));
    if (!entry.file.startsWith(`${entry.version}_`)) violations.push(`${entry.file}: version mismatch`);
    if (hash("sha256", bytes) !== entry.sha256 || bytes.length !== entry.bytes) violations.push(`${entry.file}: sha256 drifted`);
    if (hash("sha256", readFileSync(path.join(root, entry.rollback))) !== entry.rollbackSha256) {
      violations.push(`${entry.rollback}: rollback sha256 drifted`);
    }
  });
  const expectedFiles = manifest.count + migrations.length;
  if (exact && files.length !== expectedFiles) {
    violations.push(`exact: expected ${expectedFiles} migrations, found ${files.length} (${files.slice(expectedFiles).join(", ") || "too few"})`);
  }
  if (states.length !== migrations.length + 1) violations.push("suffix: expected one ledger state per applied prefix");
  states.forEach((state, index) => {
    const applied = [...versions, ...migrations.slice(0, index).map((entry) => entry.version)];
    if (state.count !== applied.length || state.head !== applied.at(-1) || state.versionListMd5 !== hash("md5", applied.join("\n"))) {
      violations.push(`suffix state ${state.name}: count, head or versionListMd5 drifted`);
    }
  });
  const authorization = JSON.parse(readFileSync(path.join(root, AUTHORIZATION_PATH), "utf8"));
  if (authorization.suffixManifest?.sha256 !== hash("sha256", readFileSync(path.join(root, SUFFIX_PATH)))) {
    violations.push("authorization template does not pin the suffix manifest");
  }
  const pinned = (authorization.migrations ?? []).map((entry) => `${entry.filename}:${entry.sha256}`);
  if (pinned.join("\n") !== migrations.map((entry) => `${entry.file}:${entry.sha256}`).join("\n")) {
    violations.push("authorization template migrations differ from the suffix manifest");
  }
  return violations;
}

if (isEntryPoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = verifyOvd635LedgerManifest(root, { exact: process.argv.includes("--exact") });
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("OVD-635 ledger manifest matches the repository migrations.");
}
