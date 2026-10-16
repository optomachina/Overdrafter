import { existsSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Proof check: a PR body needs a "## Proof" section with at least one
 * recognised item, and a UI change needs a Screenshot item. Docs-only PRs are
 * exempt. checkProof is pure; the CLI below reads the event payload and the
 * changed file list and reports to the job summary.
 */

export const PROOF_HEADING = "Proof";
export const PROOF_PLACEHOLDER = "<!-- proof: replace me -->";
export const PROOF_CHECK_MODES = Object.freeze(["report", "enforce"]);
export const JOURNEY_TEST_RULE_ID = "journey-test";

const TEMPLATE_VALUES = new Set(["<path>", "<cmd>", "<url>", "<image/url>", "<output>"]);
const ITEM_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(Test|Command|Live|Screenshot)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const URL_PATTERN = /https?:\/\/[^\s)<>"']+/i;
const JOURNEY_SPEC_PATTERN = /(?:^|[^\w./-])((?:\.\/)?e2e\/journeys\/[\w./-]*[\w-]\.spec\.ts)(?![\w.-])/g;
const ACTIONS_RUN_PATTERN = /https:\/\/github\.com\/optomachina\/Overdrafter\/actions\/runs\/\d+/i;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\b[^>]*\bsrc\s*=/i;

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

const INLINE_MAX_LENGTH = 200;

/**
 * Renders untrusted text (PR body values, file names) as one markdown code
 * span: control characters become spaces, the value is cut to 200 characters,
 * and the backtick fence is longer than any backtick run inside the value.
 * @param {unknown} value
 * @returns {string}
 */
export function safeInline(value) {
  let text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  const chars = [...text];
  if (chars.length > INLINE_MAX_LENGTH) text = `${chars.slice(0, INLINE_MAX_LENGTH).join("")}…`;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function safeInlineList(values) {
  return values.map(safeInline).join(", ");
}

function normalizePath(file) {
  return String(file).trim().replace(/^\.\//, "");
}

function isDocsFile(file) {
  return file.startsWith("docs/") || file.toLowerCase().endsWith(".md");
}

function isUiFile(file) {
  return file.startsWith("src/") && /\.(tsx|css)$/i.test(file);
}

/**
 * Returns the body of the first "## Proof" heading, up to the next level two
 * heading. Headings inside fenced blocks do not count.
 * @param {string} body
 * @returns {string | null}
 */
export function extractProofSection(body) {
  const lines = normalizeNewlines(body).split("\n");
  let fence = null;
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null || !/^##[ \t]+\S/.test(line)) continue;

    if (start === -1) {
      if (line.replace(/^##[ \t]+/, "").trim().toLowerCase() === PROOF_HEADING.toLowerCase()) start = index + 1;
    } else {
      end = index;
      break;
    }
  }

  return start === -1 ? null : lines.slice(start, end).join("\n");
}

function fencedBlockAfter(lines, index) {
  let cursor = index + 1;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  const open = cursor < lines.length ? FENCE_LINE.exec(lines[cursor]) : null;
  if (!open) return null;

  const marker = open[1];
  const content = [];
  for (let inner = cursor + 1; inner < lines.length; inner += 1) {
    const close = FENCE_LINE.exec(lines[inner]);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length && lines[inner].trim() === close[1]) {
      return { content: content.join("\n"), end: inner };
    }
    content.push(lines[inner]);
  }

  return null;
}

function cleanValue(value) {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

function isTemplateValue(value) {
  return value === "" || TEMPLATE_VALUES.has(value.toLowerCase());
}

function nextNonBlankLine(lines, index) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor].trim() !== "") return lines[cursor];
  }
  return "";
}

/**
 * Parses proof items from a Proof section with HTML comments removed.
 * @param {string} section
 * @param {{ changedFiles: Set<string>, existsInRepo?: (file: string) => boolean }} context
 */
function parseItems(section, context) {
  const lines = section.split("\n");
  const accepted = [];
  const rejected = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = ITEM_LINE.exec(line);
    if (!match) continue;
    const kind = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    const value = cleanValue(match[2]);

    if (kind === "Test") {
      const file = normalizePath(value.split(/\s+/)[0] ?? "");
      if (isTemplateValue(file)) rejected.push("Test item has no path");
      else if (context.changedFiles.has(file) || context.existsInRepo?.(file) === true) accepted.push({ kind, label: `Test: ${safeInline(file)}` });
      else rejected.push(`Test path ${safeInline(file)} is not in the diff or the repository`);
    } else if (kind === "Command") {
      if (isTemplateValue(value)) {
        rejected.push("Command item has no command");
        continue;
      }
      const block = fencedBlockAfter(lines, index);
      if (!block || block.content.trim() === "" || isTemplateValue(block.content.trim())) {
        rejected.push(`Command ${safeInline(value)} has no fenced output block`);
        continue;
      }
      accepted.push({ kind, label: `Command: ${safeInline(value)}` });
      index = block.end;
    } else if (kind === "Live") {
      const url = URL_PATTERN.exec(value);
      if (url) accepted.push({ kind, label: `Live: ${safeInline(url[0])}` });
      else rejected.push("Live item has no http(s) URL");
    } else {
      // GitHub drops an uploaded image on its own line, so look one line ahead
      // when the item has no value of its own.
      const candidate = isTemplateValue(value) ? nextNonBlankLine(lines, index).trim() : value;
      if (!isTemplateValue(candidate) && (IMAGE_PATTERN.test(candidate) || URL_PATTERN.test(candidate))) {
        accepted.push({ kind, label: "Screenshot" });
      } else {
        rejected.push("Screenshot item has no image or URL");
      }
    }
  }

  return { accepted, rejected };
}

/**
 * @param {string} prBody
 * @param {string[]} changedFiles
 * @param {{ existsInRepo?: (file: string) => boolean }} [options]
 * @returns {{ status: "pass" | "fail" | "exempt", reasons: string[] }}
 */
export function checkProof(prBody, changedFiles, options = {}) {
  const files = (changedFiles ?? []).map(normalizePath).filter(Boolean);

  if (files.length > 0 && files.every(isDocsFile)) {
    return { status: "exempt", reasons: ["every changed file is under docs/ or is a .md file"] };
  }

  const rawSection = extractProofSection(prBody);
  if (rawSection === null) {
    return { status: "fail", reasons: [`missing "## ${PROOF_HEADING}" section`] };
  }

  const section = stripHtmlComments(rawSection);
  if (section.trim() === "") {
    return {
      status: "fail",
      reasons: [
        rawSection.includes(PROOF_PLACEHOLDER)
          ? `"## ${PROOF_HEADING}" section still holds only the placeholder`
          : `"## ${PROOF_HEADING}" section is empty`,
      ],
    };
  }

  const { accepted, rejected } = parseItems(section, {
    changedFiles: new Set(files),
    existsInRepo: options.existsInRepo,
  });
  const reasons = [];

  if (accepted.length === 0) {
    reasons.push(
      "no recognised proof item (Test: <path>, Command: <cmd> with a fenced output block, Live: <url>, or Screenshot: <image/url>)",
      ...rejected,
    );
  }

  const uiFiles = files.filter(isUiFile);
  if (uiFiles.length > 0 && !accepted.some((item) => item.kind === "Screenshot")) {
    reasons.push(`UI files changed without a Screenshot item: ${safeInlineList(uiFiles)}`);
  }

  if (reasons.length > 0) return { status: "fail", reasons };
  return {
    status: "pass",
    reasons: accepted.map((item) => item.label),
  };
}

/**
 * OVD-825: a user-facing change (the same src/**\/*.tsx|*.css trigger as the
 * Screenshot rule) must reference a journey e2e spec (e2e/journeys/**\/*.spec.ts)
 * or an Actions run of it in the Proof section. When existsInRepo is given, a
 * spec path must be in the diff or the repository.
 * @param {string} prBody
 * @param {string[]} changedFiles
 * @param {{ existsInRepo?: (file: string) => boolean }} [options]
 * @returns {{ rule: string, status: "pass" | "fail" | "exempt" | "not-applicable", reasons: string[] }}
 */
export function checkJourneyTest(prBody, changedFiles, options = {}) {
  const rule = JOURNEY_TEST_RULE_ID;
  const files = (changedFiles ?? []).map(normalizePath).filter(Boolean);

  if (files.length > 0 && files.every(isDocsFile)) {
    return { rule, status: "exempt", reasons: ["every changed file is under docs/ or is a .md file"] };
  }

  const uiFiles = files.filter(isUiFile);
  if (uiFiles.length === 0) {
    return { rule, status: "not-applicable", reasons: ["no user-facing files (src/**/*.tsx or src/**/*.css) changed"] };
  }

  const rawSection = extractProofSection(prBody);
  const section = rawSection === null ? "" : stripHtmlComments(rawSection);
  const changed = new Set(files);
  const specs = [...section.matchAll(JOURNEY_SPEC_PATTERN)]
    .map((match) => normalizePath(match[1]))
    .filter((spec) => !spec.split("/").includes(".."));
  const found = options.existsInRepo
    ? specs.filter((spec) => changed.has(spec) || options.existsInRepo(spec) === true)
    : specs;
  const run = ACTIONS_RUN_PATTERN.exec(section);

  if (found.length > 0 || run) {
    return {
      rule,
      status: "pass",
      reasons: [...new Set(found)].map((spec) => `journey spec: ${safeInline(spec)}`).concat(run ? [`journey run: ${safeInline(run[0])}`] : []),
    };
  }

  const reasons = [
    rawSection === null
      ? `user-facing change has no "## ${PROOF_HEADING}" section to reference a journey test`
      : `user-facing change has no journey test reference (e2e/journeys/<name>.spec.ts or an Actions run URL) in "## ${PROOF_HEADING}"`,
  ];
  for (const spec of specs.filter((candidate) => !found.includes(candidate))) {
    reasons.push(`journey spec ${safeInline(spec)} is not in the diff or the repository`);
  }
  reasons.push(`user-facing files: ${safeInlineList(uiFiles)}`);
  return { rule, status: "fail", reasons };
}

export function formatSummary(result, mode, title = "Proof check") {
  const label = { pass: "PASS", fail: "FAIL", exempt: "EXEMPT", "not-applicable": "NOT APPLICABLE" }[result.status];
  const lines = [`### ${title}: ${label}`, "", `Mode: \`${mode}\``];
  if (result.status === "fail" && mode === "report") {
    lines.push("", "Report mode: this result does not fail the job.");
  }
  lines.push("", ...result.reasons.map((reason) => `- ${reason}`), "");
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inline] = arg.split(/=(.*)/s, 2);
    const known = ["--event", "--changed-files", "--mode", "--repo-root"];
    if (!known.includes(name)) throw new Error(`unknown argument ${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    options[name.slice(2)] = value;
  }
  return options;
}

function usage() {
  return "Usage: node scripts/proof-check.mjs --changed-files <file> [--event <event.json>] [--mode report|enforce] [--repo-root <dir>]\n"
    + "The PR body comes from --event (pull_request.body) or the PR_BODY environment variable.";
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }

  const mode = options.mode ?? env.PROOF_CHECK_MODE ?? "report";
  if (!PROOF_CHECK_MODES.includes(mode)) {
    console.error(`PROOF_CHECK_MODE must be one of ${PROOF_CHECK_MODES.join(", ")}, got "${mode}"`);
    return 2;
  }
  if (!options["changed-files"]) {
    console.error(usage());
    return 2;
  }

  let body;
  let changedFiles;
  try {
    body = options.event
      ? JSON.parse(readFileSync(options.event, "utf8"))?.pull_request?.body ?? ""
      : env.PR_BODY ?? "";
    changedFiles = readFileSync(options["changed-files"], "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    console.error(`proof-check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const repoRoot = path.resolve(options["repo-root"] ?? process.cwd());
  const existsInRepo = (file) => {
    const resolved = path.resolve(repoRoot, file);
    return resolved.startsWith(`${repoRoot}${path.sep}`) && existsSync(resolved);
  };

  const results = [
    { title: "Proof check", result: checkProof(body, changedFiles, { existsInRepo }) },
    { title: `Journey test check (${JOURNEY_TEST_RULE_ID})`, result: checkJourneyTest(body, changedFiles, { existsInRepo }) },
  ];
  const summary = results.map(({ title, result }) => formatSummary(result, mode, title)).join("\n");
  process.stdout.write(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  return mode === "enforce" && results.some(({ result }) => result.status === "fail") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
