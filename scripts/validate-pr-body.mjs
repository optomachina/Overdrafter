import { execFileSync } from "node:child_process";
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

/** Character ranges of fenced code blocks by line-based fence rules (``` and ~~~). */
function fencedLineRanges(text) {
  const lines = text.split("\n");
  const flags = fencedLineFlags(lines);
  const ranges = [];
  let offset = 0;
  lines.forEach((line, index) => {
    if (flags[index]) ranges.push([offset, offset + line.length + 1]);
    offset += line.length + 1;
  });
  return ranges;
}

const SECTION_HEADING_LINE = /^##[ \t]+(\S.*)$/gm;

function collectSections(body) {
  const normalizedBody = normalizeText(body);
  const fences = fencedCodeRanges(normalizedBody);
  const lineFences = fencedLineRanges(normalizedBody);
  const matches = [...normalizedBody.matchAll(SECTION_HEADING_LINE)].filter(
    (match) =>
      typeof match.index === "number" &&
      !isInsideRange(fences, match.index) &&
      !isInsideRange(lineFences, match.index),
  );
  const sections = new Map();

  matches.forEach((match, index) => {
    const heading = match[1].trim();
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalizedBody.length;
    const content = normalizedBody.slice(start, end).trim();
    const key = normalizeHeading(heading);
    sections.set(key, { heading, content, count: (sections.get(key)?.count ?? 0) + 1 });
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

/** Signature on the automatic envelope review item (Blaine Wilson, Oct 16, 2026). */
export const PROVIDER_GO_LIVE_AUTO_SIGNATURE = "Grok Bot under Blaine Wilson standing authority";

/**
 * `na: true` items may be marked N/A with a written justification when the
 * item does not apply to the stage being enabled. Items with `na: false` always
 * need a real evidence link. Legal stance items are never N/A, with one
 * exception: the ITAR/EAR item may be N/A for a US only provider. `auto: true`
 * items are filled by the renderer, pre-checked with the automatic signature;
 * the gate never asks a human for evidence on them, but rejects the section
 * when the automatic line is missing or unticked.
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
    text: `Envelope reviewed (automatic). Signed: ${PROVIDER_GO_LIVE_AUTO_SIGNATURE}.`,
    label: "envelope reviewed (automatic)",
    // Ticked checkbox line only; must not match prose or unticked / "not envelope reviewed".
    match: /^\s*[-*]\s*\[[xX]\]\s*\**envelope reviewed \(automatic\)/im,
    na: false,
    auto: true,
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
    id: "supplier-switch",
    group: "Admit",
    text: "Per-supplier on/off switch in the admin dashboard (immediate, worker-enforced at generic dispatch) and optional admin daily quote cap (default unlimited), via OVD-829. Evidence:",
    label: "per-supplier on/off switch in the admin dashboard",
    match: /per-supplier on\/off switch/i,
    na: false,
  },
  {
    id: "no-passwords",
    group: "Legal stance",
    text: "No stored customer passwords; encrypted session tokens only. Evidence:",
    label: "no stored customer passwords, encrypted session tokens only",
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
 * alone never count; the registry and envelope list are compared per provider
 * and migrations are read statement by statement. A disable or kill switch
 * change returns false, and so does an edit to the gate itself (that needs a
 * reviewer note instead, see validateGateChangeNote).
 */
export function enablesProvider(options = {}) {
  return detectProviderEnablement(options).some((finding) => finding.kind === "provider");
}

export const GATE_CHANGE_HEADING = "Gate change review";

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;

/**
 * Mark the lines of `lines` that sit inside a fenced code block: a fence
 * opens with 3+ backticks or tildes (a backtick fence's info string may not
 * contain a backtick), and closes with a line of the same character, at least
 * as long, with nothing after it but whitespace. An unclosed fence runs to the
 * end. Fence lines themselves count as inside.
 *
 * This errs toward fail-closed: an opener at any indent counts (CommonMark
 * allows 0-3 at top level, more inside list items), so an indented code line
 * that starts with ``` also hides what follows. A closer may be indented at
 * most 3 columns past its opener, matching CommonMark within the same container.
 */
function indentWidth(indent) {
  return [...indent].reduce((width, char) => (char === "\t" ? width + 4 - (width % 4) : width + 1), 0);
}

function fencedLineFlags(lines) {
  const flags = [];
  let fence = null;

  for (const line of lines) {
    if (fence) {
      flags.push(true);
      const close = line.match(FENCE_CLOSE);
      if (
        close &&
        close[2][0] === fence.marker[0] &&
        close[2].length >= fence.marker.length &&
        indentWidth(close[1]) <= fence.indent + 3
      ) {
        fence = null;
      }
      continue;
    }

    const open = line.match(FENCE_OPEN);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      fence = { marker: open[2], indent: indentWidth(open[1]) };
      flags.push(true);
      continue;
    }

    flags.push(false);
  }

  return flags;
}

function parseCheckboxLines(content) {
  const boxes = [];
  const lines = content.split("\n");
  const fenced = fencedLineFlags(lines);
  let continuing = false;

  for (const [index, line] of lines.entries()) {
    // A checkbox shown inside a code fence is an example, never a real answer.
    if (fenced[index]) {
      continuing = false;
      continue;
    }

    const match = line.match(CHECKBOX_LINE);
    if (match) {
      boxes.push({ checked: match[1] !== " ", text: match[2], line: line });
      continuing = true;
      continue;
    }

    const last = boxes.at(-1);
    if (continuing && last && /^[ \t]+\S/.test(line)) {
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
 * full Linear OVD issue URL. A bare OVD-n and any other https URL are not
 * evidence. Links are checked by format here; verifyEvidenceLinks additionally
 * confirms GitHub links exist. No check reads what a link says.
 */
export function extractEvidenceLinks(text) {
  const links = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (GITHUB_EVIDENCE.test(url) || LINEAR_EVIDENCE.test(url)) {
      links.push(url);
    }
  }

  return links;
}

const EVIDENCE_HINT =
  "add an evidence link (a GitHub PR, run, or commit URL in optomachina/Overdrafter, or a full Linear OVD issue URL)";

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

/**
 * An edit to the gate itself needs a "Gate change review" section naming a
 * reviewer and linking evidence, because the gate runs from the base copy and
 * cannot check its own replacement.
 */
export function validateGateChangeNote(body, findings = []) {
  const section = collectSections(body).get(normalizeHeading(GATE_CHANGE_HEADING));
  if (!section) {
    const files = findings.map((finding) => finding.file).join(", ");
    return [`missing required section "${GATE_CHANGE_HEADING}" for a PR that edits the PR body gate (${files})`];
  }
  const errors = [];
  if (!/^\s*(?:[-*]\s+)?Reviewer:\s*[A-Za-z][^\n]{2,}$/m.test(section.content)) {
    errors.push(`name a reviewer in "${GATE_CHANGE_HEADING}" with a line "Reviewer: <name>"`);
  }
  if (extractEvidenceLinks(section.content).length === 0) {
    errors.push(`${EVIDENCE_HINT} in "${GATE_CHANGE_HEADING}"`);
  }
  return errors;
}

/** Text of the automatic envelope line, ticked or not (bold markers allowed). */
const AUTO_LINE_TEXT = /^\**[ \t]*envelope reviewed \(automatic\)/i;

function validateProviderGoLiveSection(body, findings) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  const errors = [];

  if (!section) {
    const why = findings.map((finding) => `${finding.file}: ${finding.reason}`).join("; ");
    return [`missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that enables a provider (${why})`];
  }

  // Only one section is validated, so a second copy could hide an unticked first one.
  if (section.count > 1) {
    errors.push(`"${PROVIDER_GO_LIVE_HEADING}" appears ${section.count} times; keep exactly one section`);
  }

  const boxes = parseCheckboxLines(section.content);
  if (boxes.length === 0) {
    errors.push(`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`);
  }

  const unused = [...boxes];
  for (const required of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
    if (required.auto) {
      // The automatic line must be present and ticked. A ticked line satisfies it;
      // an unticked real line is consumed and rejected; lookalikes such as
      // "not envelope reviewed" are never consumed and fail as extra lines.
      const ticked = unused.findIndex((box) => box.checked && required.match.test(box.line));
      if (ticked !== -1) {
        unused.splice(ticked, 1);
        continue;
      }
      const unticked = unused.findIndex((box) => !box.checked && AUTO_LINE_TEXT.test(box.text));
      if (unticked !== -1) {
        unused.splice(unticked, 1);
        errors.push(`"${required.label}" must be ticked`);
        continue;
      }
      errors.push(`missing Provider go-live item "${required.label}"`);
      continue;
    }
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

export function collectGateEvidenceLinks(body) {
  const section = collectSections(body).get(normalizeHeading(GATE_CHANGE_HEADING));
  return section ? [...new Set(extractEvidenceLinks(section.content))] : [];
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
  const providerFindings = findings.filter((finding) => finding.kind === "provider");
  const gateFindings = findings.filter((finding) => finding.kind === "gate");
  if (providerFindings.length > 0) {
    errors.push(...validateProviderGoLiveSection(body, providerFindings));
  }
  if (gateFindings.length > 0) {
    errors.push(...validateGateChangeNote(body, gateFindings));
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
  ["--base-ref", "baseRef"],
  ["--head-ref", "headRef"],
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
 *   --base-ref <ref>             git ref of the base (default HEAD^1); the
 *                                registry and envelope list are compared
 *                                between it and the head ref
 *   --head-ref <ref>             git ref of the head (default HEAD)
 *   --verify-links               confirm GitHub evidence links resolve
 */
// An absolute path keeps a writable PATH entry from substituting git. Set
// GIT_EXECUTABLE where git lives elsewhere (for example macOS).
const GIT_EXECUTABLE = process.env.GIT_EXECUTABLE ?? "/usr/bin/git";

function gitShowReader(baseRef, headRef) {
  return (side, filePath) => {
    const ref = side === "base" ? baseRef : headRef;
    try {
      return execFileSync(GIT_EXECUTABLE, ["show", `${ref}:${filePath}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
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
  const readFile = deps.readFile ?? gitShowReader(parsed.values.baseRef ?? "HEAD^1", parsed.values.headRef ?? "HEAD");
  const detection = { changedFiles, diffText, readFile };
  const findings = detectProviderEnablement(detection);

  if (parsed.flags.has("skipUnlessEnabling") && findings.length === 0) {
    console.log("No provider enablement or gate edit in this diff; no extra PR section required.");
    return 0;
  }

  const result = validatePrBody(body, detection);
  const errors = [...result.errors];

  if (errors.length === 0 && findings.length > 0 && parsed.flags.has("verifyLinks")) {
    const links = new Set(collectGoLiveEvidenceLinks(body));
    if (findings.some((finding) => finding.kind === "gate")) {
      for (const link of collectGateEvidenceLinks(body)) links.add(link);
    }
    errors.push(...(await verifyEvidenceLinks([...links], { token: env.GITHUB_TOKEN })));
  }

  if (errors.length > 0) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  for (const finding of findings) {
    console.log(`${finding.kind === "gate" ? "Gate edit" : "Provider enablement"} detected: ${finding.file}: ${finding.reason}`);
  }
  if (findings.some((finding) => finding.kind === "provider")) sectionNames.push(PROVIDER_GO_LIVE_HEADING);
  if (findings.some((finding) => finding.kind === "gate")) sectionNames.push(GATE_CHANGE_HEADING);

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
