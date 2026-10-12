import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { detectProviderEnablement } from "./provider-enablement-detect.mjs";

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

export const PROVIDER_GO_LIVE_REPO = "optomachina/Overdrafter";

export const PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH = 12;

export const PROVIDER_GO_LIVE_NA_PLACEHOLDERS = new Set([
  "",
  "x",
  "n/a",
  "na",
  "-",
  "tbd",
  "todo",
  "none",
  "n.a",
]);

/**
 * `na: true` items may be marked N/A with a written justification when the
 * item does not apply to the stage being enabled. Items with `na: false` are
 * the legal stance and the proof of a rehearsed disable; they always need a
 * real evidence link.
 */
export const PROVIDER_GO_LIVE_REQUIRED_ITEMS = [
  {
    id: "provider-check",
    group: "Envelope",
    text: "provider:check green. Evidence:",
    label: "provider:check green",
    match: /provider:check\s+green/i,
    na: false,
  },
  {
    id: "envelope-reviewer",
    group: "Envelope",
    text: "Envelope reviewed by a named reviewer. Evidence:",
    label: "envelope reviewed by a named reviewer",
    match: /envelope reviewed by a named reviewer/i,
    na: false,
  },
  {
    id: "worker-secret",
    group: "Live",
    text: "Worker adapter deployed and Secret Manager secret created (name only). Evidence:",
    label: "worker adapter and Secret Manager secret",
    match: /secret manager secret/i,
    na: true,
  },
  {
    id: "egress",
    group: "Live",
    text: "Stable egress verified (`verify:xometry-egress`-style). Evidence:",
    label: "stable egress verified",
    match: /stable egress verified/i,
    na: true,
  },
  {
    id: "admission-revision",
    group: "Admit",
    text: "Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Admit SQL is never committed by a generator. Evidence:",
    label: "approved admission revision (generic_dispatch_enabled=true)",
    match: /approved admission revision/i,
    na: true,
  },
  {
    id: "rollout",
    group: "Admit",
    text: "`automatic_quote_collection` rollout and org enablement. Evidence:",
    label: "automatic_quote_collection rollout and org enablement",
    match: /automatic_quote_collection/i,
    na: true,
  },
  {
    id: "certification",
    group: "Admit",
    text: "Certification run evidence:",
    label: "certification run evidence",
    match: /certification run evidence/i,
    na: true,
  },
  {
    id: "rollback",
    group: "Admit",
    text: "Rollback/disable steps rehearsed. Evidence:",
    label: "rollback/disable steps rehearsed",
    match: /rollback\/disable steps rehearsed/i,
    na: false,
  },
  {
    id: "kill-switch",
    group: "Legal stance",
    text: "Per provider kill switch rehearsal (`npm run provider:kill`, `docs/runbooks/provider-cease-and-desist.md`). Evidence:",
    label: "per provider kill switch rehearsal",
    match: /kill switch rehearsal/i,
    na: false,
  },
  {
    id: "same-day-off",
    group: "Legal stance",
    text: "Provider is turned off the same day on a C&D, IP or bot block, CAPTCHA wall, or account ban. Evidence:",
    label: "provider turned off the same day on a C&D, block, CAPTCHA wall, or ban",
    match: /off the same day/i,
    na: false,
  },
  {
    id: "rate-limit",
    group: "Legal stance",
    text: "Traffic stays at about 20 quotes per provider per day. Evidence:",
    label: "about 20 quotes per provider per day",
    match: /about 20 quotes per provider per day/i,
    na: false,
  },
  {
    id: "no-evasion",
    group: "Legal stance",
    text: "Never rotate IPs, solve CAPTCHAs, mimic human pacing, or retry around a block. Evidence:",
    label: "never rotate IPs, solve CAPTCHAs, mimic human pacing, or retry around a block",
    match: /never rotate IPs/i,
    na: false,
  },
  {
    id: "no-passwords",
    group: "Legal stance",
    text: "No stored customer passwords; encrypted session tokens only, with one click revoke. Evidence:",
    label: "no stored customer passwords, encrypted session tokens, one click revoke",
    match: /no stored customer passwords/i,
    na: false,
  },
  {
    id: "export-control",
    group: "Legal stance",
    text: "ITAR/EAR controlled or uncertain uploads are blocked to foreign providers (Geomiq, Weerg) and to LLMs. Evidence:",
    label: "ITAR/EAR controlled or uncertain uploads blocked to foreign providers and LLMs",
    match: /ITAR\/EAR/i,
    na: true,
  },
];

export const PROVIDER_GO_LIVE_GROUPS = ["Envelope", "Live", "Admit", "Legal stance"];

const CHECKBOX_LINE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$/;

export { detectProviderEnablement };

/**
 * Return whether the change enables a provider for customers. Path matches
 * alone never count; the diff content must show enablement. A disable or kill
 * switch change returns false.
 */
export function enablesProvider(options = {}) {
  return detectProviderEnablement(options).length > 0;
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

const URL_PATTERN = /https:\/\/[^\s<>)\]]+/gi;

function stripUrls(text) {
  return text.replace(/\[([^\]]*)\]\(https:\/\/[^)\s]*\)/gi, "$1").replace(URL_PATTERN, " ");
}

function stripEvidenceFromJustification(text) {
  return stripUrls(text)
    .replace(/`[^`]*`/g, " ")
    .replace(/\bevidence:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderToken(token) {
  const normalized = token.toLowerCase().replace(/[.:]+$/g, "");
  return PROVIDER_GO_LIVE_NA_PLACEHOLDERS.has(normalized);
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

  const stripped = stripEvidenceFromJustification(rest);
  const realTokens = stripped.split(/[ \t,;]+/).filter((token) => token && !isPlaceholderToken(token));
  const realText = realTokens.join(" ");
  if (realText.length < PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH) {
    return { valid: false };
  }

  return { valid: true, reason: realText };
}

const GITHUB_EVIDENCE = new RegExp(
  `^https://github\\.com/${PROVIDER_GO_LIVE_REPO}/(pull/\\d+|actions/runs/\\d+|commit/[0-9a-f]{7,40})(?:[/?#].*)?$`,
  "i",
);
const LINEAR_EVIDENCE = /^https:\/\/linear\.app\/[^/\s]+\/issue\/OVD-\d+(?:[/?#].*)?$/i;

function trimUrl(url) {
  return url.replace(/[),.;]+$/g, "");
}

/**
 * Real evidence is a GitHub PR, Actions run, or commit URL in this repo, or a
 * Linear OVD issue (URL or bare OVD-n). Any other https URL is not evidence.
 */
export function extractEvidenceLinks(text) {
  const links = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (GITHUB_EVIDENCE.test(url) || LINEAR_EVIDENCE.test(url)) {
      links.push(url);
    }
  }

  const withoutUrls = text.replace(URL_PATTERN, " ");
  for (const match of withoutUrls.matchAll(/\bOVD-\d+\b/g)) {
    links.push(match[0]);
  }

  return links;
}

const EVIDENCE_HINT =
  "add an evidence link (a GitHub PR, run, or commit URL in optomachina/Overdrafter, or a Linear OVD issue)";

function checkboxResult(box, label, naAllowed) {
  const na = parseNaAnnotation(box.text);

  if (na) {
    if (!naAllowed) {
      return `N/A is not allowed for "${label}"`;
    }
    if (!box.checked) {
      return `check N/A item "${label}"`;
    }
    if (!na.valid) {
      return `mark N/A with a real written justification for "${label}"`;
    }
    return null;
  }

  if (!box.checked) {
    return `check "${label}"`;
  }

  if (extractEvidenceLinks(box.text).length === 0) {
    return `${EVIDENCE_HINT} for "${label}"`;
  }

  return null;
}

/**
 * Check only the Provider go-live section of a body (for renderers).
 */
export function validateProviderGoLive(body) {
  return validateProviderGoLiveSection(body, [{ file: "(rendered body)", reason: "provider go-live requested" }]);
}

function validateProviderGoLiveSection(body, findings) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  const errors = [];

  if (!section) {
    const why = findings.map((finding) => `${finding.file}: ${finding.reason}`).join("; ");
    return [`missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that enables a provider (${why})`];
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

    const error = checkboxResult(unused.splice(index, 1)[0], required.label, required.na);
    if (error) {
      errors.push(error);
    }
  }

  for (const box of unused) {
    const label = box.text.trim() || "an extra Provider go-live checkbox";
    const error = checkboxResult(box, label, true);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
}

/**
 * Collect the evidence links in the Provider go-live section so a caller can
 * check that they resolve.
 */
export function collectGoLiveEvidenceLinks(body) {
  const section = collectSections(body).get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  if (!section) {
    return [];
  }

  return [
    ...new Set(
      parseCheckboxLines(section.content)
        .filter((box) => box.checked && !parseNaAnnotation(box.text))
        .flatMap((box) => extractEvidenceLinks(box.text)),
    ),
  ];
}

/**
 * Confirm GitHub evidence links exist, through the GitHub REST API. Linear
 * issue references are accepted by shape only.
 *
 * @returns {Promise<string[]>} error messages, empty when every link resolves.
 */
export async function verifyEvidenceLinks(links, { fetchImpl = fetch, token } = {}) {
  const errors = [];
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "overdrafter-pr-body-gate" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const link of links) {
    const match = GITHUB_EVIDENCE.exec(link);
    if (!match) continue;
    const route = match[1]
      .replace(/^pull\//, "pulls/")
      .replace(/^commit\//, "commits/");
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${PROVIDER_GO_LIVE_REPO}/${route}`, { headers });
      if (!response.ok) {
        errors.push(`evidence link does not resolve (HTTP ${response.status}): ${link}`);
      }
    } catch (error) {
      errors.push(`could not verify evidence link ${link}: ${error instanceof Error ? error.message : error}`);
    }
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 * The Provider go-live section is required only when the diff enables a
 * provider for customers (see provider-enablement-detect.mjs).
 *
 * @param {string} body
 * @param {{ changedFiles?: string[], diffText?: string }} [options]
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

  const findings = detectProviderEnablement(options);
  if (findings.length > 0) {
    errors.push(...validateProviderGoLiveSection(body, findings));
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

const VALUE_FLAGS = new Map([
  ["--changed-files-from", "changedFilesFrom"],
  ["--diff-from", "diffFrom"],
]);

const BOOLEAN_FLAGS = new Map([
  ["--stdin", "stdin"],
  ["-", "stdin"],
  ["--skip-unless-enabling", "skipUnlessEnabling"],
  ["--verify-links", "verifyLinks"],
]);

function parseCliArgs(argv) {
  const flags = new Set();
  const values = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(BOOLEAN_FLAGS.get(arg));
    } else if (VALUE_FLAGS.has(arg)) {
      values[VALUE_FLAGS.get(arg)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

async function readLines(filePath) {
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * CLI entrypoint for validating pull request bodies from a file or stdin.
 *
 *   --changed-files-from <path>  git diff --name-status --no-renames output
 *   --diff-from <path>           git diff --no-renames unified diff
 *   --skip-unless-enabling       pass without checking when the diff does not
 *                                enable a provider (the PR body gate uses this)
 *   --verify-links               confirm GitHub evidence links resolve
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCliArgs(argv);
  const useStdin = parsed.flags.has("stdin");
  const filePath = useStdin ? null : parsed.positional[0];

  if (!useStdin && !filePath) {
    console.error(
      "Usage: npm run validate:pr-body -- <path-to-markdown> | --stdin [--changed-files-from <path>] [--diff-from <path>] [--skip-unless-enabling] [--verify-links]",
    );
    return 1;
  }

  for (const flag of VALUE_FLAGS.keys()) {
    if (argv.includes(flag) && parsed.values[VALUE_FLAGS.get(flag)] === undefined) {
      console.error(`Usage: ${flag} requires a path`);
      return 1;
    }
  }

  const body = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
  const changedFiles = parsed.values.changedFilesFrom ? await readLines(parsed.values.changedFilesFrom) : [];
  const diffText = parsed.values.diffFrom ? await fs.readFile(parsed.values.diffFrom, "utf8") : "";
  const findings = detectProviderEnablement({ changedFiles, diffText });

  if (parsed.flags.has("skipUnlessEnabling") && findings.length === 0) {
    console.log("No provider enablement in this diff; Provider go-live section not required.");
    return 0;
  }

  const result = validatePrBody(body, { changedFiles, diffText });
  const errors = [...result.errors];

  if (errors.length === 0 && findings.length > 0 && parsed.flags.has("verifyLinks")) {
    errors.push(...(await verifyEvidenceLinks(collectGoLiveEvidenceLinks(body), { token: env.GITHUB_TOKEN })));
  }

  if (errors.length > 0) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  if (findings.length > 0) {
    sectionNames.push(PROVIDER_GO_LIVE_HEADING);
    for (const finding of findings) {
      console.log(`Provider enablement detected: ${finding.file}: ${finding.reason}`);
    }
  }

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
