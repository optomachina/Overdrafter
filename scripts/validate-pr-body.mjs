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

function collectSections(body) {
  const normalizedBody = normalizeText(body);
  const matches = [...normalizedBody.matchAll(/^##\s+(.+)$/gm)];
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

export const PROVIDER_DISPATCH_ENVELOPE_DIR = "provider-dispatch-envelope/";

export const PROVIDER_GO_LIVE_REQUIRED_ITEMS = [
  { id: "provider-check", label: "provider:check green", match: /provider:check\s+green/i },
  { id: "envelope-reviewer", label: "envelope reviewed by a named reviewer", match: /named reviewer/i },
  {
    id: "admission-revision",
    label: "approved admission revision (generic_dispatch_enabled=true)",
    match: /generic_dispatch_enabled\s*=\s*true/i,
  },
  {
    id: "rollout",
    label: "automatic_quote_collection rollout and org enablement",
    match: /automatic_quote_collection/i,
  },
  { id: "worker-secret", label: "worker adapter and Secret Manager secret", match: /secret manager/i },
  { id: "egress", label: "stable egress verified", match: /egress/i },
  { id: "certification", label: "certification run evidence", match: /certification/i },
  { id: "rollback", label: "rollback/disable steps rehearsed", match: /rollback/i },
];

const CHECKBOX_LINE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;

/**
 * Return whether any changed path is under a `provider-dispatch-envelope/` directory.
 */
export function touchesProviderDispatchEnvelope(changedFiles = []) {
  return changedFiles.some((file) => String(file).replaceAll("\\", "/").includes(PROVIDER_DISPATCH_ENVELOPE_DIR));
}

function parseCheckboxLines(content) {
  return content.split("\n").flatMap((line) => {
    const match = line.match(CHECKBOX_LINE);
    if (!match) {
      return [];
    }

    return [{ checked: match[1] !== " ", text: match[2] }];
  });
}

function naReason(text) {
  const match = text.match(/\bN\/A\b[:\s—-]*(.*)$/i);
  if (!match) {
    return null;
  }

  const reason = match[1].trim();
  return /[A-Za-z0-9]/.test(reason) ? reason : "";
}

function hasEvidence(text) {
  if (/https?:\/\//i.test(text)) {
    return true;
  }

  const evidence = text.match(/evidence:\s*(.+)$/i);
  return Boolean(evidence && /[A-Za-z0-9]/.test(evidence[1]));
}

function checkboxSatisfied(box, requiredItem) {
  const reason = naReason(box.text);
  if (reason !== null) {
    return reason.length > 0;
  }

  if (!box.checked) {
    return false;
  }

  if (requiredItem?.id === "provider-check") {
    return true;
  }

  return hasEvidence(box.text);
}

function extraCheckboxSatisfied(box) {
  const reason = naReason(box.text);
  if (reason !== null) {
    return reason.length > 0;
  }

  return box.checked;
}

function validateProviderGoLiveSection(body) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  const errors = [];

  if (!section) {
    return [
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches provider-dispatch-envelope/`,
    ];
  }

  const boxes = parseCheckboxLines(section.content);
  if (boxes.length === 0) {
    errors.push(`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`);
  }

  for (const required of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
    const match = boxes.find((box) => required.match.test(box.text));
    if (!match) {
      errors.push(`missing Provider go-live item "${required.label}"`);
      continue;
    }

    if (checkboxSatisfied(match, required)) {
      continue;
    }

    if (naReason(match.text) !== null) {
      errors.push(`mark N/A with a reason for "${required.label}"`);
    } else if (!match.checked) {
      errors.push(`check or mark N/A with a reason for "${required.label}"`);
    } else {
      errors.push(`add an evidence link or note for "${required.label}"`);
    }
  }

  for (const box of boxes) {
    const required = PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((item) => item.match.test(box.text));
    if (required || extraCheckboxSatisfied(box)) {
      continue;
    }

    const label = box.text.trim() || "an extra Provider go-live checkbox";
    errors.push(`check or mark N/A with a reason for "${label}"`);
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 * The Provider go-live section is required only when `changedFiles` touch `provider-dispatch-envelope/`.
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

  if (touchesProviderDispatchEnvelope(options.changedFiles ?? [])) {
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
    ? (await fs.readFile(parsed.values.changedFilesFrom, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : undefined;
  const result = validatePrBody(body, changedFiles ? { changedFiles } : {});

  if (!result.ok) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(result.errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  if (touchesProviderDispatchEnvelope(changedFiles ?? [])) {
    sectionNames.push(PROVIDER_GO_LIVE_HEADING);
  }

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
