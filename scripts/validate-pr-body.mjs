/**
 * PR-body validator (`npm run validate:pr-body`).
 *
 * Heading rule: a section is any ATX heading of level 2 or 3 (`##` / `###`).
 * Titles match case-insensitively after trimming. A section ends at the next
 * heading of the same or a higher level (fewer `#`), so a `## X` section
 * includes its `###` subsections. Headings and checkboxes inside fenced code
 * blocks (``` or ~~~) are ignored. When a title repeats, the first one wins.
 *
 * Provider go-live: required only when a changed file matches
 * `PROVIDER_GO_LIVE_PATH_PATTERNS` (root-anchored globs, not substrings). Each
 * required item is satisfied only by its own checkbox line whose text starts
 * with the item's template label. Every item must be ticked `[x]`. A ticked
 * item carries either real evidence (URL, backticked command/output, 7-40 hex
 * commit SHA, or repo file path) or, for non-admission items only, `N/A:` with
 * a real reason. See `docs/checklists/provider-go-live-checklist.md`.
 */
import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REQUIRED_SECTIONS = [
  {
    heading: "Summary",
    placeholders: ["Describe the change briefly."],
    type: "generic",
  },
  {
    heading: "Problem",
    placeholders: ["What problem does this PR solve?"],
    type: "generic",
  },
  {
    heading: "Scope",
    placeholders: ["What is included in this PR?", "What is intentionally not included?"],
    type: "generic",
  },
  {
    heading: "Verification",
    placeholders: [
      "List the exact commands run locally and whether they passed.",
      "Prefer `npm run verify` unless a narrower command set was the right fit for the change.",
      "If unrelated baseline failures surfaced, describe them separately from current-change failures.",
      "# npm run verify",
    ],
    type: "verification",
  },
  {
    heading: "Tests",
    placeholders: ["What tests were added or updated?", "If none were added, explain why."],
    type: "generic",
  },
  {
    heading: "Migration notes",
    placeholders: [],
    type: "choice",
  },
  {
    heading: "Rollback / risk notes",
    placeholders: ["What could go wrong?", "How would this be rolled back if needed?"],
    type: "generic",
  },
  {
    heading: "Documentation",
    placeholders: [],
    type: "choice",
  },
];

const CHOICE_SECTION_BOILERPLATE = {
  "Migration notes": [
    "- [ ] No migration impact",
    "- [x] No migration impact",
    "- [X] No migration impact",
    "- [ ] Migration impact exists and is described below",
    "- [x] Migration impact exists and is described below",
    "- [X] Migration impact exists and is described below",
  ],
  Documentation: [
    "- [ ] Docs updated",
    "- [x] Docs updated",
    "- [X] Docs updated",
    "- [ ] No doc updates needed",
    "- [x] No doc updates needed",
    "- [X] No doc updates needed",
  ],
};

function normalizeHeading(value) {
  return value.trim().toLowerCase();
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function stripCodeBlocks(value) {
  return value.replace(/```[\s\S]*?```/g, " ");
}

function stripMarkdown(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s{0,3}[-*]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^\s{0,3}[-*]\s+/gm, "")
    .replace(/^Details:\s*$/gim, "")
    .replace(/^Commands run:\s*$/gim, "")
    .replace(/^Results:\s*$/gim, "")
    .replace(/^Baseline failures or exceptions:\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulText(value) {
  return /[A-Za-z0-9]/.test(stripMarkdown(stripCodeBlocks(value)));
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Tag each line with whether it sits inside (or on the fence of) a fenced code block.
 */
function classifyFencedLines(text) {
  let fence = null;

  return text.split("\n").map((line) => {
    const marker = line.match(FENCE_OPEN)?.[1];
    if (fence) {
      const closes =
        marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim();
      if (closes) {
        fence = null;
      }
      return { line, fenced: true };
    }

    if (marker) {
      fence = marker;
    }
    return { line, fenced: Boolean(marker) };
  });
}

const SECTION_HEADING = /^\s{0,3}(#{2,3})\s+(.+?)(?:\s+#+)?\s*$/;

function collectSections(body) {
  const lines = classifyFencedLines(normalizeText(body));
  const headings = [];

  lines.forEach(({ line, fenced }, index) => {
    const match = fenced ? null : line.match(SECTION_HEADING);
    if (match) {
      headings.push({ index, level: match[1].length, heading: match[2].trim() });
    }
  });

  const sections = new Map();
  headings.forEach((current, position) => {
    const next = headings.slice(position + 1).find((candidate) => candidate.level <= current.level);
    const content = lines
      .slice(current.index + 1, next ? next.index : lines.length)
      .map((entry) => entry.line)
      .join("\n")
      .trim();
    const key = normalizeHeading(current.heading);
    if (!sections.has(key)) {
      sections.set(key, { heading: current.heading, content });
    }
  });

  return sections;
}

function findPlaceholder(content, placeholders) {
  const normalizedContent = normalizeText(content);
  return placeholders.find((placeholder) => normalizedContent.includes(placeholder)) ?? null;
}

function hasCheckedBox(content) {
  return /^\s*[-*]\s+\[[xX]\]/m.test(content);
}

function hasExecutableCommand(content) {
  const blocks = [...content.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)];

  return blocks.some((block) =>
    block[1]
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line && !line.startsWith("#")),
  );
}

function validateGenericSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push(`replace template placeholder text in "${rule.heading}"`);
  }

  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (!hasMeaningfulText(withoutPlaceholders)) {
    errors.push(`add non-empty content to "${rule.heading}"`);
  }

  return errors;
}

function validateChoiceSection(content, rule) {
  const withoutBoilerplate = CHOICE_SECTION_BOILERPLATE[rule.heading].reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (hasCheckedBox(content) || hasMeaningfulText(withoutBoilerplate)) {
    return [];
  }

  return [`mark or explain "${rule.heading}" instead of leaving it blank`];
}

function validateVerificationSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push('replace template placeholder text in "Verification"');
  }

  if (!hasExecutableCommand(content)) {
    errors.push('add at least one real command to "Verification"');
  }

  const nonCommandContent = stripCodeBlocks(content);
  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    nonCommandContent,
  );
  const withoutCheckboxLines = withoutPlaceholders.replace(/^\s{0,3}[-*]\s+\[[ xX]\].*$/gm, " ");

  if (!hasCheckedBox(content) && !hasMeaningfulText(withoutCheckboxLines)) {
    errors.push('record an outcome in "Verification"');
  }

  return errors;
}

export const PROVIDER_GO_LIVE_HEADING = "Provider go-live";

/**
 * Repo paths where a provider is defined, wired, or admitted. A PR that changes
 * (adds, modifies, deletes, or renames into or out of) any matching path must
 * carry a complete Provider go-live section.
 *
 * Globs are anchored at the repo root: `*` matches within one path segment and
 * `**` matches across segments. Matching is case-sensitive like git paths and
 * never uses substring search, so `my-provider-dispatch-envelope/a` does not match.
 */
export const PROVIDER_GO_LIVE_PATH_PATTERNS = [
  // Reviewed dispatch envelopes (fixtures, worker allowlist, reviewed SQL).
  "test-fixtures/provider-dispatch-envelope/**",
  "worker/src/providerDispatchEnvelope.ts",
  "supabase/migrations/*_reviewed_dispatch_envelope.sql",
  // Provider registry and its generators/checkers (OVD-691 / PR #661).
  "provider-integrations/**",
  "worker/src/generated/providerRegistry.ts",
  "scripts/provider-registry.mjs",
  "scripts/provider-sync.mjs",
  "scripts/provider-check.mjs",
  "worker/scripts/generated/provider-secrets.sh",
];

function globToRegExp(pattern) {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}

const PROVIDER_GO_LIVE_PATH_MATCHERS = PROVIDER_GO_LIVE_PATH_PATTERNS.map(globToRegExp);

function normalizeRepoPath(file) {
  return String(file).trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}

/**
 * Return whether one repo-relative path matches a provider go-live pattern.
 */
export function matchesProviderGoLivePath(file) {
  const normalized = normalizeRepoPath(file);
  return PROVIDER_GO_LIVE_PATH_MATCHERS.some((matcher) => matcher.test(normalized));
}

/**
 * Return the changed paths that require the Provider go-live section.
 */
export function providerGoLivePaths(changedFiles = []) {
  return changedFiles.filter(matchesProviderGoLivePath).map(normalizeRepoPath);
}

export function touchesProviderGoLivePath(changedFiles = []) {
  return providerGoLivePaths(changedFiles).length > 0;
}

const NAME_STATUS_LINE = /^[A-Z]\d*\t/;

/**
 * Parse `git diff --name-only` or `git diff --name-status` output into paths.
 * Rename/copy lines (`R100\told\tnew`) yield both the source and destination so a
 * file moved out of a protected path still triggers the gate.
 */
export function parseChangedFiles(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) {
        return [];
      }

      if (NAME_STATUS_LINE.test(line)) {
        return line.split("\t").slice(1).filter(Boolean);
      }

      return [line.trim()];
    });
}

/**
 * Required Provider go-live items. Each item is satisfied only by its own
 * checkbox line whose text starts with `label` (case-insensitive, whitespace
 * collapsed). Items with `admission: true` represent the decision to admit the
 * provider (repo checks green, envelope review, admission revision) and can
 * never be marked N/A.
 */
export const PROVIDER_GO_LIVE_REQUIRED_ITEMS = [
  { id: "provider-check", label: "provider:check green", admission: true },
  { id: "envelope-reviewer", label: "Envelope reviewed by a named reviewer", admission: true },
  {
    id: "worker-secret",
    label: "Worker adapter deployed and Secret Manager secret created (name only)",
    admission: false,
  },
  { id: "egress", label: "Stable egress verified (`verify:xometry-egress`-style)", admission: false },
  {
    id: "admission-revision",
    label: "Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied",
    admission: true,
  },
  { id: "rollout", label: "`automatic_quote_collection` rollout and org enablement", admission: false },
  { id: "certification", label: "Certification run passed", admission: false },
  { id: "rollback", label: "Rollback/disable steps rehearsed", admission: false },
];

export const NA_REASON_MIN_LENGTH = 15;
export const NA_REASON_MIN_WORDS = 3;

const CHECKBOX_LINE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const PLACEHOLDER_REASONS = new Set(["x", "n/a", "na", "-", "--", "tbd", "todo", "none", "...", "…", "."]);
const PLACEHOLDER_EVIDENCE = [
  /\b(?:tbd|todo|fixme|placeholder|xxx+)\b/i,
  /<[^>\n]*>/,
  /(?:^|\s)(?:\.{3}|…)(?:\s|$)/,
];
const EVIDENCE_PATTERNS = [
  /\bhttps?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#]\S*)?/i,
  /`[^`]*[A-Za-z0-9][^`]*`/,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i,
  /(?:^|[\s(])(?:\.\/)?[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]+\b/,
];

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseCheckboxLines(content) {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");

  return classifyFencedLines(withoutComments).flatMap(({ line, fenced }) => {
    const match = fenced ? null : line.match(CHECKBOX_LINE);
    if (!match) {
      return [];
    }

    return [{ checked: match[1] !== " ", text: collapseWhitespace(match[2]) }];
  });
}

/**
 * Return the text after `label` when the line starts with it at a word boundary,
 * otherwise null.
 */
function remainderAfterLabel(text, label) {
  const normalizedLabel = collapseWhitespace(label).toLowerCase();
  if (!text.toLowerCase().startsWith(normalizedLabel)) {
    return null;
  }

  const rest = text.slice(normalizedLabel.length);
  return /^(?:$|[\s.:;,—–-])/.test(rest) ? rest : null;
}

/**
 * The attestation is the text after `Evidence:` when present, otherwise the text
 * after the label (leading punctuation removed).
 */
function attestationText(remainder) {
  const evidenceIndex = remainder.search(/\bevidence\s*:/i);
  const raw =
    evidenceIndex >= 0 ? remainder.slice(evidenceIndex).replace(/^evidence\s*:/i, "") : remainder;
  return raw.replace(/^\s*[.:;,—–-]?(?=\s|$)/, "").trim();
}

function naReasonFrom(attestation) {
  const match = attestation.match(/^N\/A\b\s*[:—–-]?\s*(.*)$/i);
  return match ? match[1].trim() : null;
}

function naReasonIsReal(reason) {
  if (PLACEHOLDER_REASONS.has(reason.toLowerCase())) {
    return false;
  }

  const words = reason.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  return reason.length >= NA_REASON_MIN_LENGTH && words.length >= NA_REASON_MIN_WORDS;
}

function hasPlaceholderEvidence(attestation) {
  return PLACEHOLDER_EVIDENCE.some((pattern) => pattern.test(attestation));
}

function hasRealEvidence(attestation) {
  return EVIDENCE_PATTERNS.some((pattern) => pattern.test(attestation));
}

function validateProviderGoLiveItem(required, boxes) {
  const matches = boxes.flatMap((box) => {
    const remainder = remainderAfterLabel(box.text, required.label);
    return remainder === null ? [] : [{ box, remainder }];
  });

  if (matches.length === 0) {
    return [`missing Provider go-live item "${required.label}" (start its own checkbox line with the template label)`];
  }

  if (matches.length > 1) {
    return [`use exactly one checkbox line for Provider go-live item "${required.label}"`];
  }

  const [{ box, remainder }] = matches;
  const attestation = attestationText(remainder);
  const naReason = naReasonFrom(attestation);
  const errors = [];

  if (!box.checked) {
    errors.push(`tick [x] for Provider go-live item "${required.label}"`);
  }

  if (naReason !== null) {
    if (required.admission) {
      errors.push(`"${required.label}" is an admission item and cannot be N/A`);
    } else if (!naReasonIsReal(naReason)) {
      errors.push(
        `give a real N/A reason (at least ${NA_REASON_MIN_LENGTH} characters and ${NA_REASON_MIN_WORDS} words) for "${required.label}"`,
      );
    }
    return errors;
  }

  if (hasPlaceholderEvidence(attestation)) {
    errors.push(`replace placeholder evidence for "${required.label}"`);
  } else if (!hasRealEvidence(attestation)) {
    errors.push(
      `add evidence (URL, \`command\`, commit SHA, or repo file path) for "${required.label}"`,
    );
  }

  return errors;
}

function validateProviderGoLiveSection(body, triggeringPaths) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));

  if (!section) {
    return [
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches provider go-live paths (${triggeringPaths.join(", ")})`,
    ];
  }

  const boxes = parseCheckboxLines(section.content);
  if (boxes.length === 0) {
    return [`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`];
  }

  const errors = PROVIDER_GO_LIVE_REQUIRED_ITEMS.flatMap((required) => validateProviderGoLiveItem(required, boxes));

  for (const box of boxes) {
    const isRequired = PROVIDER_GO_LIVE_REQUIRED_ITEMS.some(
      (required) => remainderAfterLabel(box.text, required.label) !== null,
    );
    if (!isRequired && !box.checked) {
      errors.push(`tick [x] or remove the extra Provider go-live checkbox "${box.text || "(empty)"}"`);
    }
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 * The Provider go-live section is required only when `changedFiles` match `PROVIDER_GO_LIVE_PATH_PATTERNS`.
 *
 * @param {string} body
 * @param {{ changedFiles?: string[] }} [options]
 */
export function validatePrBody(body, options = {}) {
  const sections = collectSections(body);
  const errors = [];

  for (const rule of REQUIRED_SECTIONS) {
    const section = sections.get(normalizeHeading(rule.heading));

    if (!section) {
      errors.push(`missing required section "${rule.heading}"`);
      continue;
    }

    const sectionErrors =
      rule.type === "verification"
        ? validateVerificationSection(section.content, rule)
        : rule.type === "choice"
          ? validateChoiceSection(section.content, rule)
          : validateGenericSection(section.content, rule);

    errors.push(...sectionErrors);
  }

  const triggeringPaths = providerGoLivePaths(options.changedFiles ?? []);
  if (triggeringPaths.length > 0) {
    errors.push(...validateProviderGoLiveSection(body, triggeringPaths));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function formatValidationErrors(errors) {
  return errors.map((error) => `- ${error}`).join("\n");
}

async function readStdin() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

function parseCliArgs(argv) {
  const flags = new Set();
  const values = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdin" || arg === "-") {
      flags.add("stdin");
      continue;
    }

    if (arg === "--changed-files-from") {
      values.changedFilesFrom = argv[index + 1];
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  return { flags, values, positional };
}

/**
 * CLI entrypoint for validating pull request bodies from a file or stdin.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const useStdin = parsed.flags.has("stdin");
  const filePath = useStdin ? null : parsed.positional[0];

  if (!useStdin && !filePath) {
    console.error(
      "Usage: npm run validate:pr-body -- <path-to-markdown> | --stdin [--changed-files-from <path>]",
    );
    return 1;
  }

  if (parsed.values.changedFilesFrom === undefined && argv.includes("--changed-files-from")) {
    console.error("Usage: --changed-files-from requires a path");
    return 1;
  }

  const body = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
  const changedFiles = parsed.values.changedFilesFrom
    ? parseChangedFiles(await fs.readFile(parsed.values.changedFilesFrom, "utf8"))
    : undefined;
  const result = validatePrBody(body, changedFiles ? { changedFiles } : {});

  if (!result.ok) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(result.errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  if (touchesProviderGoLivePath(changedFiles ?? [])) {
    sectionNames.push(PROVIDER_GO_LIVE_HEADING);
  }

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
