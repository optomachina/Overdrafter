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

/**
 * Heading rule:
 * - Required PR sections, including Provider go-live, are delimited by ATX
 *   `##` headings only.
 * - `###` headings are subsections and stay inside the parent `##` section.
 * - Headings that appear inside fenced code blocks (``` ... ```) are ignored.
 */
function fencedCodeRanges(text) {
  const ranges = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf("```", searchFrom);
    if (start === -1) {
      break;
    }

    const endFence = text.indexOf("```", start + 3);
    const end = endFence === -1 ? text.length : endFence + 3;
    ranges.push([start, end]);
    searchFrom = end;
  }

  return ranges;
}

function isInsideRange(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const SECTION_HEADING_LINE = /^##[ \t]+(\S.*)$/gm;

function collectSections(body) {
  const normalizedBody = normalizeText(body);
  const fences = fencedCodeRanges(normalizedBody);
  const matches = [...normalizedBody.matchAll(SECTION_HEADING_LINE)].filter(
    (match) => typeof match.index === "number" && !isInsideRange(fences, match.index),
  );
  const sections = new Map();

  matches.forEach((match, index) => {
    const heading = match[1].trim();
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalizedBody.length;
    const content = normalizedBody.slice(start, end).trim();
    sections.set(normalizeHeading(heading), { heading, content });
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

export const PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE = "worker/src/providerDispatchEnvelope.ts";

export const PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX = "provider-integrations/";

export const PROVIDER_GO_LIVE_REVIEWED_MIGRATION =
  /^supabase\/migrations\/[^/]+_reviewed_dispatch_envelope\.sql$/;

export const PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH = 12;

export const PROVIDER_GO_LIVE_NA_PLACEHOLDERS = new Set(["", "x", "n/a", "na", "-", "tbd", "todo", "n.a"]);

export const PROVIDER_GO_LIVE_REQUIRED_ITEMS = [
  {
    id: "provider-check",
    label: "provider:check green",
    match: /provider:check\s+green/i,
    admission: false,
  },
  {
    id: "envelope-reviewer",
    label: "envelope reviewed by a named reviewer",
    match: /envelope reviewed by a named reviewer/i,
    admission: false,
  },
  {
    id: "admission-revision",
    label: "approved admission revision (generic_dispatch_enabled=true)",
    match: /approved admission revision/i,
    admission: true,
  },
  {
    id: "rollout",
    label: "automatic_quote_collection rollout and org enablement",
    match: /automatic_quote_collection/i,
    admission: true,
  },
  {
    id: "worker-secret",
    label: "worker adapter and Secret Manager secret",
    match: /secret manager secret/i,
    admission: false,
  },
  {
    id: "egress",
    label: "stable egress verified",
    match: /stable egress verified/i,
    admission: false,
  },
  {
    id: "certification",
    label: "certification run evidence",
    match: /certification run evidence/i,
    admission: true,
  },
  {
    id: "rollback",
    label: "rollback/disable steps rehearsed",
    match: /rollback\/disable steps rehearsed/i,
    admission: true,
  },
];

const CHECKBOX_LINE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$/;
const GIT_NAME_STATUS_LINE = /^[A-Z](?:\d{1,3})?\t(.+)$/;

/**
 * Expand `git diff --name-status` lines so rename sources and destinations
 * both appear as plain paths. Plain path lists are returned unchanged.
 */
export function normalizeChangedFiles(changedFiles = []) {
  return changedFiles.flatMap((entry) => {
    const raw = String(entry).replaceAll("\\", "/").trim();
    if (!raw) {
      return [];
    }

    const statusMatch = GIT_NAME_STATUS_LINE.exec(raw);
    if (!statusMatch) {
      return [raw];
    }

    return statusMatch[1]
      .split("\t")
      .map((part) => part.trim())
      .filter(Boolean);
  });
}

/**
 * Match a changed path by exact file, directory prefix, or glob — never by
 * substring. Protected go-live paths are:
 * - `worker/src/providerDispatchEnvelope.ts`
 * - `supabase/migrations/*_reviewed_dispatch_envelope.sql`
 * - `provider-integrations/**`
 */
export function isProviderGoLivePath(file) {
  const normalized = String(file).replaceAll("\\", "/");
  if (normalized === PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE) {
    return true;
  }

  if (normalized === "provider-integrations" || normalized.startsWith(PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX)) {
    return true;
  }

  return PROVIDER_GO_LIVE_REVIEWED_MIGRATION.test(normalized);
}

/**
 * Return whether any changed path (including rename sources) is a provider
 * go-live path.
 */
export function touchesProviderGoLivePaths(changedFiles = []) {
  return normalizeChangedFiles(changedFiles).some((file) => isProviderGoLivePath(file));
}

function parseCheckboxLines(content) {
  const boxes = [];

  for (const line of content.split("\n")) {
    const match = line.match(CHECKBOX_LINE);
    if (match) {
      boxes.push({ checked: match[1] !== " ", text: match[2] });
      continue;
    }

    const last = boxes.at(-1);
    if (last && /^[ \t]+\S/.test(line)) {
      last.text += ` ${line.trim()}`;
    }
  }

  return boxes;
}

function parseNaAnnotation(text) {
  const marker = text.search(/\bN\/A\b/i);
  if (marker === -1) {
    return null;
  }

  let rest = text.slice(marker + 3).trimStart();
  if (rest.startsWith(":") || rest.startsWith("—") || rest.startsWith("-")) {
    rest = rest.slice(1).trimStart();
  }

  const reason = rest.trim();
  const normalized = reason.toLowerCase().replace(/\.+$/, "");
  if (PROVIDER_GO_LIVE_NA_PLACEHOLDERS.has(normalized) || reason.length < PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH) {
    return { present: true, valid: false, reason };
  }

  return { present: true, valid: true, reason };
}

function hasEvidence(text) {
  if (/https?:\/\/\S+/i.test(text)) {
    return true;
  }

  if (/\b[a-f0-9]{7,40}\b/i.test(text)) {
    return true;
  }

  if (/(?:^|[\s`'(])(?:\.\/|\/)?(?:[\w.-]+\/)+[\w.-]+/.test(text)) {
    return true;
  }

  return /(?:^|[\s`])(?:\$ |npm run |npx |pnpm |yarn |git )/.test(text);
}

function checkboxResult(box, requiredItem) {
  const na = parseNaAnnotation(box.text);

  if (na) {
    if (requiredItem.admission) {
      return { ok: false, error: `N/A is not allowed for admission item "${requiredItem.label}"` };
    }

    if (!box.checked) {
      return { ok: false, error: `check N/A item "${requiredItem.label}"` };
    }

    if (!na.valid) {
      return { ok: false, error: `mark N/A with a real justification for "${requiredItem.label}"` };
    }

    if (!hasEvidence(box.text)) {
      return { ok: false, error: `add evidence (link, command, SHA, or path) for "${requiredItem.label}"` };
    }

    return { ok: true, error: null };
  }

  if (!box.checked) {
    return { ok: false, error: `check "${requiredItem.label}"` };
  }

  if (!hasEvidence(box.text)) {
    return { ok: false, error: `add evidence (link, command, SHA, or path) for "${requiredItem.label}"` };
  }

  return { ok: true, error: null };
}

function extraCheckboxResult(box) {
  const na = parseNaAnnotation(box.text);
  const label = box.text.trim() || "an extra Provider go-live checkbox";

  if (na) {
    if (!box.checked) {
      return { ok: false, error: `check N/A item "${label}"` };
    }

    if (!na.valid) {
      return { ok: false, error: `mark N/A with a real justification for "${label}"` };
    }

    if (!hasEvidence(box.text)) {
      return { ok: false, error: `add evidence (link, command, SHA, or path) for "${label}"` };
    }

    return { ok: true, error: null };
  }

  if (!box.checked) {
    return { ok: false, error: `check "${label}"` };
  }

  if (!hasEvidence(box.text)) {
    return { ok: false, error: `add evidence (link, command, SHA, or path) for "${label}"` };
  }

  return { ok: true, error: null };
}

function validateProviderGoLiveSection(body) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  const errors = [];

  if (!section) {
    return [`missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`];
  }

  const boxes = parseCheckboxLines(section.content);
  if (boxes.length === 0) {
    errors.push(`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`);
  }

  const unused = [...boxes];
  for (const required of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
    const index = unused.findIndex((box) => required.match.test(box.text));
    if (index === -1) {
      errors.push(`missing Provider go-live item "${required.label}"`);
      continue;
    }

    const match = unused.splice(index, 1)[0];
    const result = checkboxResult(match, required);
    if (!result.ok) {
      errors.push(result.error);
    }
  }

  for (const box of unused) {
    const result = extraCheckboxResult(box);
    if (!result.ok) {
      errors.push(result.error);
    }
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 * The Provider go-live section is required only when `changedFiles` touch a
 * provider go-live path (`worker/src/providerDispatchEnvelope.ts`,
 * `supabase/migrations/*_reviewed_dispatch_envelope.sql`, or
 * `provider-integrations/**`).
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

  if (touchesProviderGoLivePaths(options.changedFiles ?? [])) {
    errors.push(...validateProviderGoLiveSection(body));
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

    if (arg === "--skip-unless-go-live") {
      flags.add("skipUnlessGoLive");
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
      "Usage: npm run validate:pr-body -- <path-to-markdown> | --stdin [--changed-files-from <path>] [--skip-unless-go-live]",
    );
    return 1;
  }

  if (parsed.values.changedFilesFrom === undefined && argv.includes("--changed-files-from")) {
    console.error("Usage: --changed-files-from requires a path");
    return 1;
  }

  const body = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
  const changedFiles = parsed.values.changedFilesFrom
    ? (await fs.readFile(parsed.values.changedFilesFrom, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : undefined;
  if (parsed.flags.has("skipUnlessGoLive") && !touchesProviderGoLivePaths(changedFiles ?? [])) {
    console.log("No provider go-live paths changed; skipping Provider go-live validation.");
    return 0;
  }

  const result = validatePrBody(body, changedFiles ? { changedFiles } : {});

  if (!result.ok) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(result.errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  if (touchesProviderGoLivePaths(changedFiles ?? [])) {
    sectionNames.push(PROVIDER_GO_LIVE_HEADING);
  }

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
