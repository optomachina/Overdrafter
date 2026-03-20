import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { formatValidationErrors, validatePrBody } from "./validate-pr-body.mjs";

function usage() {
  return "Usage: npm run render:pr-body -- <path-to-json> | --stdin";
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeStringList(value, label) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length === 0) {
      throw new Error(`${label} must not be empty`);
    }

    return [normalized];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string or array`);
  }

  return value.map((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
}

function normalizeOptionalStringList(value, label) {
  if (value === undefined) {
    return [];
  }

  return normalizeStringList(value, label);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function formatBulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCheckboxLine(checked, label) {
  return `- [${checked ? "x" : " "}] ${label}`;
}

function formatCommands(commands) {
  return `\`\`\`bash\n${commands.join("\n")}\n\`\`\``;
}

function normalizeVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verification must be an object");
  }

  return {
    allPassed: assertBoolean(value.allPassed, "verification.allPassed"),
    usedVerify: assertBoolean(value.usedVerify, "verification.usedVerify"),
    usedNarrowVerification: assertBoolean(
      value.usedNarrowVerification,
      "verification.usedNarrowVerification",
    ),
    hasOtherVerification: assertBoolean(
      value.hasOtherVerification,
      "verification.hasOtherVerification",
    ),
    commands: normalizeStringList(value.commands, "verification.commands"),
    results: normalizeStringList(value.results, "verification.results"),
    baselineFailures: normalizeOptionalStringList(
      value.baselineFailures,
      "verification.baselineFailures",
    ),
  };
}

function normalizeChoiceSection(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    hasImpact: assertBoolean(value.hasImpact, `${label}.hasImpact`),
    details: normalizeOptionalStringList(value.details, `${label}.details`),
  };
}

function normalizeDocumentation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("documentation must be an object");
  }

  return {
    updated: assertBoolean(value.updated, "documentation.updated"),
    details: normalizeOptionalStringList(value.details, "documentation.details"),
  };
}

function normalizeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PR body input must be a JSON object");
  }

  return {
    summary: normalizeStringList(value.summary, "summary"),
    problem: normalizeStringList(value.problem, "problem"),
    scope: normalizeStringList(value.scope, "scope"),
    verification: normalizeVerification(value.verification),
    tests: normalizeStringList(value.tests, "tests"),
    migrationNotes: normalizeChoiceSection(value.migrationNotes, "migrationNotes"),
    rollbackRisks: normalizeStringList(value.rollbackRisks, "rollbackRisks"),
    documentation: normalizeDocumentation(value.documentation),
  };
}

function renderChoiceDetails(details, emptyFallback = "None.") {
  return details.length > 0 ? formatBulletList(details) : emptyFallback;
}

export function renderPrBody(input) {
  const normalized = normalizeInput(input);

  const migrationDetails = normalized.migrationNotes.hasImpact
    ? renderChoiceDetails(normalized.migrationNotes.details)
    : normalized.migrationNotes.details.length > 0
      ? formatBulletList(normalized.migrationNotes.details)
      : "No migration impact.";

  const documentationDetails = normalized.documentation.updated
    ? renderChoiceDetails(normalized.documentation.details)
    : normalized.documentation.details.length > 0
      ? formatBulletList(normalized.documentation.details)
      : "No doc updates needed.";

  const hasBaselineFailures = normalized.verification.baselineFailures.length > 0;
  const baselineFailures = hasBaselineFailures
    ? formatBulletList(normalized.verification.baselineFailures)
    : "None.";

  const body = [
    "## Summary",
    "",
    formatBulletList(normalized.summary),
    "",
    "## Problem",
    "",
    formatBulletList(normalized.problem),
    "",
    "## Scope",
    "",
    formatBulletList(normalized.scope),
    "",
    "## Verification",
    "",
    formatCheckboxLine(normalized.verification.usedVerify, "`npm run verify`"),
    formatCheckboxLine(
      normalized.verification.usedNarrowVerification,
      "narrower commands were used intentionally and are listed below",
    ),
    formatCheckboxLine(normalized.verification.hasOtherVerification, "other relevant verification"),
    "",
    "Commands run:",
    "",
    formatCommands(normalized.verification.commands),
    "",
    "Results:",
    "",
    formatCheckboxLine(normalized.verification.allPassed, "all listed verification passed"),
    formatCheckboxLine(hasBaselineFailures, "unrelated baseline failure(s) are described below"),
    formatCheckboxLine(
      normalized.verification.usedNarrowVerification,
      "narrower verification was intentionally sufficient and is justified below",
    ),
    formatBulletList(normalized.verification.results),
    "",
    "Baseline failures or exceptions:",
    "",
    baselineFailures,
    "",
    "## Tests",
    "",
    formatBulletList(normalized.tests),
    "",
    "## Migration notes",
    "",
    formatCheckboxLine(!normalized.migrationNotes.hasImpact, "No migration impact"),
    formatCheckboxLine(
      normalized.migrationNotes.hasImpact,
      "Migration impact exists and is described below",
    ),
    "",
    "Details:",
    "",
    migrationDetails,
    "",
    "## Rollback / risk notes",
    "",
    formatBulletList(normalized.rollbackRisks),
    "",
    "## Documentation",
    "",
    formatCheckboxLine(normalized.documentation.updated, "Docs updated"),
    formatCheckboxLine(!normalized.documentation.updated, "No doc updates needed"),
    "",
    "Details:",
    "",
    documentationDetails,
    "",
  ].join("\n");

  const validation = validatePrBody(body);
  if (!validation.ok) {
    throw new Error(`Rendered PR body failed validation:\n${formatValidationErrors(validation.errors)}`);
  }

  return body;
}

async function readStdin() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

export async function main(argv = process.argv.slice(2)) {
  const useStdin = argv.includes("--stdin") || argv[0] === "-";
  const filePath = useStdin ? null : argv[0];

  if (!useStdin && !filePath) {
    console.error(usage());
    return 1;
  }

  try {
    const raw = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
    const input = JSON.parse(raw);
    process.stdout.write(renderPrBody(input));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
