#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lifecycle action types that count as cleanup deletions. The installed Cloud
 * Storage API supports Delete, SetStorageClass, and
 * AbortIncompleteMultipartUpload; only Delete removes stored generations.
 */
export const LIFECYCLE_DELETE_ACTION_TYPES = Object.freeze([
  "Delete",
]);

/**
 * Fail-closed evaluation of the four bucket controls the runbook requires
 * before any snapshot-mode deployment may proceed. Input is the JSON object
 * emitted by the installed gcloud storage CLI, which uses snake_case keys:
 *
 *   gcloud storage buckets describe gs://BUCKET \
 *     --format='json(public_access_prevention,uniform_bucket_level_access,versioning_enabled,lifecycle_config)'
 *
 * Expected shape: public_access_prevention is a string, uniform_bucket_level_access
 * and versioning_enabled are booleans, and lifecycle_config.rule is a
 * non-empty array of well-formed action entries containing at least one
 * action.type from LIFECYCLE_DELETE_ACTION_TYPES. Absent fields or unexpected
 * types fail closed. Returns { ok, invalid, failures } where failures are
 * stable sanitized codes that never include bucket or object names.
 */
export function evaluateSnapshotBucketControls(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, invalid: true, failures: ["invalid_bucket_metadata"] };
  }

  const failures = [];

  if (metadata.public_access_prevention !== "enforced") {
    failures.push("public_access_prevention_not_enforced");
  }
  if (metadata.uniform_bucket_level_access !== true) {
    failures.push("uniform_bucket_level_access_disabled");
  }
  if (metadata.versioning_enabled !== true) {
    failures.push("versioning_disabled");
  }
  if (!hasCleanupLifecycle(metadata)) {
    failures.push("lifecycle_delete_action_missing");
  }

  return { ok: failures.length === 0, invalid: false, failures };
}

function hasCleanupLifecycle(metadata) {
  const rules = metadata.lifecycle_config?.rule;
  if (!Array.isArray(rules) || rules.length < 1) return false;
  const everyRuleIsWellFormed = rules.every(
    (rule) =>
      Boolean(rule) &&
      typeof rule === "object" &&
      !Array.isArray(rule) &&
      typeof rule.action?.type === "string",
  );
  if (!everyRuleIsWellFormed) return false;
  return rules.some((rule) => LIFECYCLE_DELETE_ACTION_TYPES.includes(rule.action.type));
}

async function readStdin(input) {
  if (typeof input === "string") return input;
  const chunks = [];
  for await (const chunk of input) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** CLI contract: exit 0 pass, 1 missing controls, 2 unreadable metadata. */
export async function runCli({ input = process.stdin, output = process.stdout } = {}) {
  let metadata;
  try {
    metadata = JSON.parse(await readStdin(input));
  } catch {
    output.write("Snapshot bucket metadata could not be parsed; failing closed.\n");
    return 2;
  }

  const result = evaluateSnapshotBucketControls(metadata);
  if (result.invalid) {
    output.write("Snapshot bucket metadata could not be parsed; failing closed.\n");
    return 2;
  }

  if (!result.ok) {
    output.write("Snapshot bucket control preflight failed:\n");
    for (const failure of result.failures) {
      output.write(`  - ${failure}\n`);
    }
    output.write("Refusing snapshot-mode deployment until every required control is present.\n");
    return 1;
  }

  output.write("Snapshot bucket control preflight passed.\n");
  return 0;
}

/**
 * Direct-invocation detection that survives symlinked entry paths: Node
 * realpath-resolves import.meta.url but not process.argv[1], so a naive
 * comparison fails open (the CLI would exit 0 without evaluating). Both
 * sides are normalized through the filesystem; any resolution failure keeps
 * library imports safe.
 */
function invokedDirectlyFromCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(entry))
    );
  } catch {
    return false;
  }
}

if (invokedDirectlyFromCli()) {
  process.exitCode = await runCli();
}
