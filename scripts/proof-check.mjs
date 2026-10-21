import { isEntryPoint } from "./lib/entry-point.mjs";
import { readFileSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Proof check: a PR body needs a "## Proof" section with at least one
 * recognised item, and a UI change needs a Screenshot item. Docs-only PRs are
 * exempt. Test paths and the npm scripts and files a Command names must be
 * real (OVD-841). checkProof is pure; the CLI below reads the event payload and
 * the changed file list, reports to the job summary and optionally writes a
 * JSON report (docs/proof-check.md).
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

export const COMMAND_SHAPES = ["npm run <script>", "npm test [-- <path>]", "npx vitest run [<path>]", "node <file>", "bash <file>", "scripts/<file>"]
  .map((shape) => `\`${shape}\``)
  .join(", ");

function tokenize(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function looksLikePath(arg) {
  return !arg.startsWith("-") && arg.includes("/") && !/[*?{}[\]$]/.test(arg) && !/^[a-z][\w+.-]*:/i.test(arg);
}

function afterDoubleDash(args) {
  const index = args.indexOf("--");
  return index === -1 ? [] : args.slice(index + 1);
}

// Flags whose next argument is a value (a module, pattern, or reporter), not a file to check.
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions", "--input-type", "--title"]);
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--check"]);
const BASH_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const TEST_VALUE_FLAGS = new Set([
  "-t", "--testNamePattern", "--reporter", "-c", "--config", "-r", "--root", "--dir", "--project", "--environment",
  "--outputFile", "--pool", "--shard", "--exclude", "--mode", "--workspace", "--coverage.include", "--coverage.exclude",
  "--coverage.reporter", "--coverage.reportsDirectory",
]);

/**
 * Splits args into operands, skipping the value after flags known to take one.
 * An operand right after an unknown bare flag may be that flag's value, so it
 * is marked uncertain: if it does not exist the command is unverifiable, not
 * rejected.
 * @returns {{ arg: string, index: number, certain: boolean }[]}
 */
function operands(args, valueFlags) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "-") {
      result.push({ arg, index, certain: index === 0 || !isBareFlag(args[index - 1], valueFlags) });
    } else if (valueFlags.has(arg)) {
      index += 1;
    }
  }
  return result;
}

function isBareFlag(arg, valueFlags) {
  return arg.startsWith("-") && arg !== "-" && !arg.includes("=") && !valueFlags.has(arg);
}

function pathOperands(args, valueFlags) {
  return operands(args, valueFlags)
    .filter(({ arg }) => looksLikePath(arg))
    .map(({ arg, certain }) => ({ path: arg, certain }));
}

/**
 * Parses one command (no &&) into the npm scripts and files it refers to, or
 * null when the shape is not one the check knows how to verify.
 * @param {string} segment
 * @returns {{ scripts: string[], files: { path: string, certain: boolean }[] } | null}
 */
function parseCommandSegment(segment) {
  const tokens = tokenize(segment);
  while (tokens.length > 0 && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
  const [head, ...args] = tokens;

  if (head === "npm" && args[0] === "run") {
    const name = args[1];
    if (!name || name.startsWith("-")) return null;
    return { scripts: [name], files: pathOperands(afterDoubleDash(args), TEST_VALUE_FLAGS) };
  }
  if (head === "npm" && args[0] === "test") {
    return { scripts: ["test"], files: pathOperands(afterDoubleDash(args), TEST_VALUE_FLAGS) };
  }
  if (head === "npx" && args[0] === "vitest" && args[1] === "run") {
    return { scripts: [], files: pathOperands(args.slice(2), TEST_VALUE_FLAGS) };
  }
  if (head === "node" || head === "bash") {
    const evalFlags = head === "node" ? NODE_EVAL_FLAGS : new Set(["-c"]);
    const valueFlags = head === "node" ? NODE_VALUE_FLAGS : BASH_VALUE_FLAGS;
    // Flags after the script belong to the script, so only scan up to it.
    const script = operands(args, valueFlags)[0];
    const interpreterArgs = script ? args.slice(0, script.index) : args;
    if (!script || interpreterArgs.some((arg) => evalFlags.has(arg.split("=")[0]))) return null;
    return { scripts: [], files: [{ path: script.arg, certain: script.certain }] };
  }
  if (head && /^(?:\.\/)?scripts\/\S+$/.test(head)) {
    return { scripts: [], files: [{ path: head, certain: true }] };
  }
  return null;
}

/**
 * Checks that a Command value refers to real npm scripts and files.
 * @returns {{ status: "accepted", evidence: object[] } | { status: "rejected", message: string } | { status: "unverifiable", message: string }}
 */
function verifyCommand(value, context) {
  const label = `Command: ${safeInline(value)}`;
  const segments = value.split(/\s+&&\s+/);
  // A single & left after splitting on && backgrounds a second command the check would ignore.
  const parsed = segments.map((segment) => (/[|;<>&`]|\$\(/.test(segment) ? null : parseCommandSegment(segment)));
  if (parsed.some((entry) => entry === null)) {
    return { status: "unverifiable", message: `${label} — unverifiable command shape (recognised: ${COMMAND_SHAPES})` };
  }

  const evidence = [];
  for (const { scripts, files } of parsed) {
    for (const name of scripts) {
      const source = context.scriptSource(name);
      if (!source) return { status: "rejected", message: `${label} — no such script ${safeInline(name)} in package.json` };
      evidence.push({ kind: "npm-script", ref: name, source });
    }
    for (const { path: raw, certain } of files) {
      const file = normalizePath(raw);
      const source = context.fileSource(file);
      if (!source && !certain) {
        return { status: "unverifiable", message: `${label} — cannot tell whether ${safeInline(file)} is a file or an option value` };
      }
      if (!source) return { status: "rejected", message: `${label} — ${safeInline(file)} does not exist in the repo or this PR` };
      evidence.push({ kind: "file", ref: file, source });
    }
  }
  return { status: "accepted", evidence };
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
 * Parses proof items from a Proof section with HTML comments removed. Every
 * item lands in `items`; `accepted` and `rejected` carry the summary lines.
 * An unverifiable Command is accepted with a warning in report mode and
 * rejected in enforce mode.
 * @param {string} section
 * @param {{ mode: string, fileSource: (file: string) => string | null, scriptSource: (name: string) => string | null }} context
 */
function parseItems(section, context) {
  const lines = section.split("\n");
  const items = [];
  const accepted = [];
  const rejected = [];
  const warnings = [];
  const accept = (kind, value, label, evidence) => {
    items.push({ kind, value, status: "accepted", evidence });
    accepted.push({ kind, label });
  };
  const reject = (kind, value, message) => {
    items.push({ kind, value, status: "rejected", evidence: [], message });
    rejected.push(message);
  };
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
      const source = isTemplateValue(file) ? null : context.fileSource(file);
      if (isTemplateValue(file)) reject(kind, value, "Test item has no path");
      else if (source) accept(kind, file, `Test: ${safeInline(file)}`, [{ kind: "file", ref: file, source }]);
      else reject(kind, file, `Test: ${safeInline(file)} does not exist in the repo or this PR`);
    } else if (kind === "Command") {
      if (isTemplateValue(value)) {
        reject(kind, value, "Command item has no command");
        continue;
      }
      const block = fencedBlockAfter(lines, index);
      if (!block || block.content.trim() === "" || isTemplateValue(block.content.trim())) {
        reject(kind, value, `Command ${safeInline(value)} has no fenced output block`);
        continue;
      }
      index = block.end;
      const verdict = verifyCommand(value, context);
      if (verdict.status === "accepted") {
        accept(kind, value, `Command: ${safeInline(value)}`, verdict.evidence);
      } else if (verdict.status === "rejected") {
        reject(kind, value, verdict.message);
      } else {
        items.push({ kind, value, status: "unverifiable", evidence: [], message: verdict.message });
        if (context.mode === "enforce") {
          rejected.push(verdict.message);
        } else {
          accepted.push({ kind, label: `Command: ${safeInline(value)}` });
          warnings.push(verdict.message);
        }
      }
    } else if (kind === "Live") {
      const url = URL_PATTERN.exec(value);
      if (url) accept(kind, url[0], `Live: ${safeInline(url[0])}`, [{ kind: "url", ref: url[0] }]);
      else reject(kind, value, "Live item has no http(s) URL");
    } else {
      // GitHub drops an uploaded image on its own line, so look one line ahead
      // when the item has no value of its own.
      const candidate = isTemplateValue(value) ? nextNonBlankLine(lines, index).trim() : value;
      if (!isTemplateValue(candidate) && (IMAGE_PATTERN.test(candidate) || URL_PATTERN.test(candidate))) {
        accept(kind, candidate, "Screenshot", [{ kind: IMAGE_PATTERN.test(candidate) ? "image" : "url", ref: URL_PATTERN.exec(candidate)?.[0] ?? null }]);
      } else {
        reject(kind, value, "Screenshot item has no image or URL");
      }
    }
  }

  return { items, accepted, rejected, warnings };
}

function toScriptSet(scripts) {
  return scripts instanceof Set ? scripts : new Set(scripts ?? []);
}

/**
 * Any rejected item fails the check, each with its own reason. A Test path or
 * a file a Command names must be in the diff or the repository; an npm script
 * a Command names must be in the base or head package.json.
 * @param {string} prBody
 * @param {string[]} changedFiles
 * @param {{
 *   existsInRepo?: (file: string) => boolean,
 *   packageScripts?: { base?: Iterable<string>, head?: Iterable<string> },
 *   mode?: "report" | "enforce",
 * }} [options]
 * @returns {{ status: "pass" | "fail" | "exempt", reasons: string[], warnings: string[], items: object[] }}
 */
export function checkProof(prBody, changedFiles, options = {}) {
  const files = (changedFiles ?? []).map(normalizePath).filter(Boolean);
  const result = (status, reasons, items = [], warnings = []) => ({ status, reasons, warnings, items });

  if (files.length > 0 && files.every(isDocsFile)) {
    return result("exempt", ["every changed file is under docs/ or is a .md file"]);
  }

  const rawSection = extractProofSection(prBody);
  if (rawSection === null) {
    return result("fail", [`missing "## ${PROOF_HEADING}" section`]);
  }

  const section = stripHtmlComments(rawSection);
  if (section.trim() === "") {
    return result("fail", [
      rawSection.includes(PROOF_PLACEHOLDER)
        ? `"## ${PROOF_HEADING}" section still holds only the placeholder`
        : `"## ${PROOF_HEADING}" section is empty`,
    ]);
  }

  const changed = new Set(files);
  const baseScripts = toScriptSet(options.packageScripts?.base);
  const headScripts = toScriptSet(options.packageScripts?.head);
  const { items, accepted, rejected, warnings } = parseItems(section, {
    mode: options.mode ?? "report",
    fileSource: (file) => {
      if (changed.has(file)) return "diff";
      return options.existsInRepo?.(file) === true ? "repo" : null;
    },
    scriptSource: (name) => {
      if (baseScripts.has(name)) return "base";
      return headScripts.has(name) ? "head" : null;
    },
  });
  const reasons = [];

  if (accepted.length === 0) {
    reasons.push("no recognised proof item (Test: <path>, Command: <cmd> with a fenced output block, Live: <url>, or Screenshot: <image/url>)");
  }
  reasons.push(...rejected);

  const uiFiles = files.filter(isUiFile);
  if (uiFiles.length > 0 && !accepted.some((item) => item.kind === "Screenshot")) {
    reasons.push(`UI files changed without a Screenshot item: ${safeInlineList(uiFiles)}`);
  }

  if (reasons.length > 0) return result("fail", reasons, items, warnings);
  return result("pass", accepted.map((item) => item.label), items, warnings);
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
  lines.push("", ...result.reasons.map((reason) => `- ${reason}`));
  lines.push(...(result.warnings ?? []).map((warning) => `- Warning: ${warning}`), "");
  return lines.join("\n");
}

export const PROOF_REPORT_VERSION = 1;

/**
 * Machine-readable result for later consumers (OVD-845). The shape is
 * documented in docs/proof-check.md; bump PROOF_REPORT_VERSION on a breaking
 * change.
 */
export function buildJsonReport(proof, journey, mode) {
  const rules = [proof, journey];
  let status = "pass";
  if (rules.some((rule) => rule.status === "fail")) status = "fail";
  else if (proof.status === "exempt") status = "exempt";
  const accepted = proof.items.filter((item) => item.status !== "rejected" && !(item.status === "unverifiable" && mode === "enforce"));
  return {
    version: PROOF_REPORT_VERSION,
    mode,
    status,
    rules: {
      proof: { status: proof.status, reasons: proof.reasons, warnings: proof.warnings },
      [journey.rule]: { status: journey.status, reasons: journey.reasons },
    },
    items: proof.items,
    accepted,
    evidenceKinds: [...new Set(accepted.flatMap((item) => item.evidence.map((evidence) => evidence.kind)))].sort((a, b) => a.localeCompare(b)),
  };
}

function readScripts(file) {
  try {
    return Object.keys(JSON.parse(readFileSync(file, "utf8"))?.scripts ?? {});
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inline] = arg.split(/=(.*)/s, 2);
    const known = ["--event", "--changed-files", "--mode", "--repo-root", "--json", "--head-package-json"];
    if (!known.includes(name)) throw new Error(`unknown argument ${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    options[name.slice(2)] = value;
  }
  return options;
}

function usage() {
  return "Usage: node scripts/proof-check.mjs --changed-files <file> [--event <event.json>] [--mode report|enforce] [--repo-root <dir>]\n"
    + "         [--json <out.json>] [--head-package-json <package.json>]\n"
    + "The PR body comes from --event (pull_request.body) or the PR_BODY environment variable.\n"
    + "--json and --head-package-json fall back to PROOF_CHECK_JSON and PROOF_CHECK_HEAD_PACKAGE_JSON.";
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
    // A directory is not proof: `node scripts` must not count as a real file.
    return resolved.startsWith(`${repoRoot}${path.sep}`) && statSync(resolved, { throwIfNoEntry: false })?.isFile() === true;
  };

  const headPackageJson = options["head-package-json"] ?? env.PROOF_CHECK_HEAD_PACKAGE_JSON;
  const packageScripts = {
    base: readScripts(path.join(repoRoot, "package.json")),
    head: headPackageJson ? readScripts(headPackageJson) : [],
  };

  const proof = checkProof(body, changedFiles, { existsInRepo, packageScripts, mode });
  const journey = checkJourneyTest(body, changedFiles, { existsInRepo });
  const results = [
    { title: "Proof check", result: proof },
    { title: `Journey test check (${JOURNEY_TEST_RULE_ID})`, result: journey },
  ];
  const summary = results.map(({ title, result }) => formatSummary(result, mode, title)).join("\n");
  process.stdout.write(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  const report = buildJsonReport(proof, journey, mode);
  const jsonPath = options.json ?? env.PROOF_CHECK_JSON;
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `status=${report.status}\n${jsonPath ? `json=${jsonPath}\n` : ""}`);
  }

  return mode === "enforce" && report.status === "fail" ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(main());
}
