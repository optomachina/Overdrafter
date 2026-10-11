/** Allocate the next free Supabase migration timestamp. Names files only; never writes or applies SQL. */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIGRATION_BASE_REF = "origin/main";
export const MIGRATION_FILENAME_PATTERN = /^(\d{14})_[a-z0-9_-]+\.sql$/;
export const MIGRATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
export const MIGRATIONS_TREE = "supabase/migrations";

const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class MissingMigrationBaseRefError extends Error {
  constructor(baseRef, cause) {
    super(
      `Unable to read migrations from ${baseRef}; fetch that ref before allocating a timestamp.`,
    );
    this.name = "MissingMigrationBaseRefError";
    this.baseRef = baseRef;
    this.cause = cause;
  }
}

export function assertMigrationSlug(slug) {
  if (typeof slug !== "string" || !MIGRATION_SLUG_PATTERN.test(slug)) {
    throw new Error("migration slug must match [a-z0-9][a-z0-9_-]*");
  }
  return slug;
}

export function parseMigrationTimestamp(filename) {
  const base = String(filename).split("/").pop();
  const match = base.match(MIGRATION_FILENAME_PATTERN);
  return match ? match[1] : null;
}

export function formatMigrationTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new Error("now must be a valid Date");
  }
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function incrementMigrationTimestamp(timestamp) {
  if (typeof timestamp !== "string" || !/^\d{14}$/.test(timestamp)) {
    throw new Error(`invalid migration timestamp: ${timestamp}`);
  }
  const date = new Date(Date.UTC(
    Number(timestamp.slice(0, 4)),
    Number(timestamp.slice(4, 6)) - 1,
    Number(timestamp.slice(6, 8)),
    Number(timestamp.slice(8, 10)),
    Number(timestamp.slice(10, 12)),
    Number(timestamp.slice(12, 14)),
  ));
  date.setUTCSeconds(date.getUTCSeconds() + 1);
  return formatMigrationTimestamp(date);
}

export function latestMigrationTimestamp(filenames) {
  let latest = null;
  for (const filename of filenames) {
    const timestamp = parseMigrationTimestamp(filename);
    if (timestamp && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

export function listLocalMigrationFilenames(rootDir) {
  return readdirSync(join(rootDir, MIGRATIONS_TREE))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function listRefMigrationFilenames(rootDir, baseRef = DEFAULT_MIGRATION_BASE_REF) {
  if (typeof baseRef !== "string" || !GIT_REF_PATTERN.test(baseRef)) {
    throw new Error("baseRef must be a git ref name");
  }
  try {
    const output = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", baseRef, "--", MIGRATIONS_TREE],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output
      .split("\n")
      .filter((line) => line.endsWith(".sql"))
      .map((line) => line.slice(MIGRATIONS_TREE.length + 1))
      .sort();
  } catch (error) {
    throw new MissingMigrationBaseRefError(baseRef, error);
  }
}

export function nextMigrationTimestamp({
  rootDir = process.cwd(),
  now = new Date(),
  baseRef = DEFAULT_MIGRATION_BASE_REF,
  localFilenames,
  refFilenames,
} = {}) {
  const local = localFilenames ?? listLocalMigrationFilenames(rootDir);
  const remote = refFilenames ?? listRefMigrationFilenames(rootDir, baseRef);
  const latest = latestMigrationTimestamp([...local, ...remote]);
  const nowTimestamp = formatMigrationTimestamp(now);
  if (!latest) {
    return nowTimestamp;
  }
  const afterLatest = incrementMigrationTimestamp(latest);
  return nowTimestamp > afterLatest ? nowTimestamp : afterLatest;
}

export function migrationFilename(timestamp, slug) {
  if (typeof timestamp !== "string" || !/^\d{14}$/.test(timestamp)) {
    throw new Error(`invalid migration timestamp: ${timestamp}`);
  }
  return `${timestamp}_${assertMigrationSlug(slug)}.sql`;
}

export function nextMigrationFilename({ slug, ...options } = {}) {
  return migrationFilename(nextMigrationTimestamp(options), slug);
}

export function main(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const slug = argv[0];
  if (!slug || argv.length !== 1) {
    stderr.write("Usage: npm run migration:next -- <slug>\n");
    return 1;
  }
  try {
    stdout.write(`${nextMigrationFilename({ slug, rootDir: cwd })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  process.exitCode = main();
}
