#!/usr/bin/env node
// OVD-857: Release bot merge-plan read-back and show-me-your-work decision log.
// Pure local git plumbing on a given repo path. This script never merges,
// pushes, fetches, or touches a remote; the operator refreshes refs first.
// Exit codes: 0 ok, 1 tree mismatch / unverified / log rewritten, 2 usage error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DECISION_COLUMNS = ["ts", "pr", "head_sha", "patch_id", "verdict_ref", "action", "merge_sha", "tree_match", "result"];
export const DECISION_HEADER = `${DECISION_COLUMNS.join("\t")}\n`;
export const ACTIONS = ["plan-land", "plan-stop", "readback"];

function git(repo, args, input) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitOk(repo, args) {
  try {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveCommit(repo, rev) {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  } catch {
    return null;
  }
}

const treeOf = (repo, rev) => git(repo, ["rev-parse", `${rev}^{tree}`]);

// Stable patch-id of the diff base..head; "" when the diff is empty.
export function patchId(repo, base, head) {
  const diff = git(repo, ["diff-tree", "-p", "--no-color", base, head]);
  if (!diff) return "";
  return git(repo, ["patch-id", "--stable"], `${diff}\n`).split(/\s+/)[0] ?? "";
}

function lookupVerdict(verdicts, pr) {
  if (typeof verdicts === "function") return verdicts(pr);
  if (verdicts instanceof Map) return verdicts.get(pr) ?? verdicts.get(String(pr));
  return verdicts?.[pr] ?? verdicts?.[String(pr)];
}

// stack: bottom-up [{pr, head_sha}]. verdicts: OVD-845 lookup, either a
// function pr -> {sha, verdict_ref, valid} or a map/object keyed by PR.
// Lands only the contiguous verified run from the bottom; stops at the first
// PR without a valid verdict for its current head SHA.
export function planContiguousVerified(stack, verdicts) {
  const land = [];
  for (const entry of stack) {
    const verdict = lookupVerdict(verdicts, entry.pr);
    let reason = null;
    if (!verdict) reason = "no-verdict";
    else if (verdict.valid !== true) reason = "verdict-not-valid";
    else if (!entry.head_sha || verdict.sha !== entry.head_sha) reason = "verdict-sha-stale";
    else if (!verdict.verdict_ref) reason = "verdict-ref-missing";
    if (reason) {
      return { land, stop: { pr: entry.pr, head_sha: entry.head_sha ?? "", verdict_ref: verdict?.verdict_ref ?? "", reason } };
    }
    land.push({ pr: entry.pr, head_sha: entry.head_sha, verdict_ref: verdict.verdict_ref });
  }
  return { land, stop: null };
}

// Read main back after a merge. A queued merge or an armed auto-merge is not a
// merge: the commit must exist, be on mainRef, and its tree must equal the
// verified head's tree, or (after a rebase) carry the identical patch-id and
// equal the verified head rebased onto the merge commit's parent.
export function readBack({ repo, mergeSha, verifiedHead, verifiedBase, mainRef = "main" }) {
  const result = {
    merge_sha: mergeSha ?? "",
    verified_head: verifiedHead ?? "",
    tree_match: false,
    mode: null,
    on_main: false,
    merge_tree: "",
    expected_tree: "",
    patch_id: "",
    verified_patch_id: "",
    reason: "",
  };
  const merge = mergeSha ? resolveCommit(repo, mergeSha) : null;
  const head = verifiedHead ? resolveCommit(repo, verifiedHead) : null;
  if (!merge) return { ...result, reason: "merge-commit-missing" };
  if (!head) return { ...result, reason: "verified-head-missing" };
  result.merge_sha = merge;
  result.verified_head = head;

  const main = resolveCommit(repo, mainRef);
  result.on_main = Boolean(main) && gitOk(repo, ["merge-base", "--is-ancestor", merge, main]);

  const parents = git(repo, ["rev-list", "--parents", "-n", "1", merge]).split(" ").slice(1);
  const parent = parents[0] ?? null;
  const base = verifiedBase ? resolveCommit(repo, verifiedBase) : parent ? git(repo, ["merge-base", parent, head]) : null;

  result.merge_tree = treeOf(repo, merge);
  result.expected_tree = treeOf(repo, head);
  if (parent) result.patch_id = patchId(repo, parent, merge);
  if (base) result.verified_patch_id = patchId(repo, base, head);

  if (!result.on_main) return { ...result, reason: "not-on-main" };
  if (parents.length !== 1) return { ...result, reason: "not-a-single-parent-squash" };

  if (result.merge_tree === result.expected_tree) {
    return { ...result, tree_match: true, mode: "exact", reason: "tree-equals-verified-head" };
  }
  if (!base) return { ...result, reason: "tree-mismatch" };
  if (result.patch_id !== result.verified_patch_id) return { ...result, reason: "tree-mismatch-patch-id-differs" };

  let rebasedTree = "";
  try {
    rebasedTree = git(repo, ["merge-tree", "--write-tree", `--merge-base=${base}`, parent, head]).split("\n")[0];
  } catch {
    return { ...result, reason: "rebase-conflict" };
  }
  result.expected_tree = rebasedTree;
  if (rebasedTree === result.merge_tree) {
    return { ...result, tree_match: true, mode: "rebased", reason: "patch-id-and-rebased-tree-match" };
  }
  return { ...result, reason: "tree-mismatch-after-rebase" };
}

function readBackRow(merge, result) {
  return {
    pr: merge.pr,
    head_sha: result.verified_head || merge.head_sha,
    patch_id: result.patch_id,
    verdict_ref: merge.verdict_ref,
    action: "readback",
    merge_sha: result.merge_sha || merge.merge_sha,
    tree_match: String(result.tree_match),
    result: result.tree_match ? `landed (${result.mode})` : `STOP ${result.reason}: flag to Grok Bot and Blaine, no auto-revert`,
  };
}

// merges: bottom-up [{pr, head_sha, verdict_ref, merge_sha, verified_base?}].
// Reads each merge back in order, logs one row per read-back, and stops at the
// first tree_match=false. Later merges are not read back or reported landed.
export function readBackRun({ repo, merges, logPath, mainRef = "main" }) {
  const landed = [];
  for (const merge of merges) {
    const result = readBack({ repo, mergeSha: merge.merge_sha, verifiedHead: merge.head_sha, verifiedBase: merge.verified_base, mainRef });
    if (logPath) appendDecision(logPath, readBackRow(merge, result));
    if (!result.tree_match) return { landed, stop: { pr: merge.pr, ...result } };
    landed.push({ pr: merge.pr, ...result });
  }
  return { landed, stop: null };
}

// One TSV cell: single line, no tabs, and no leading formula bytes.
export function sanitizeCell(value) {
  const text = String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function formatDecisionRow(row) {
  const unknown = Object.keys(row).filter((key) => !DECISION_COLUMNS.includes(key));
  if (unknown.length) throw new Error(`unknown decision column(s): ${unknown.join(", ")}`);
  if (!ACTIONS.includes(row.action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
  const filled = { ...row, ts: row.ts ?? new Date().toISOString() };
  return `${DECISION_COLUMNS.map((column) => sanitizeCell(filled[column])).join("\t")}\n`;
}

// Append-only: writes the header on first use, never rewrites prior bytes.
export function appendDecision(logPath, row) {
  const line = formatDecisionRow(row);
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, DECISION_HEADER);
  } else if (!fs.readFileSync(logPath, "utf8").startsWith(DECISION_HEADER)) {
    throw new Error(`${logPath} does not start with the decision-log header`);
  }
  fs.appendFileSync(logPath, line);
  return line;
}

export function logDigest(logPath) {
  const bytes = fs.readFileSync(logPath);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// prior: a string/Buffer snapshot of earlier content, or {bytes, sha256} from
// logDigest. Passes only if the current log keeps those bytes as its prefix.
export function verifyAppendOnly(logPath, prior) {
  if (!fs.existsSync(logPath)) return { ok: false, reason: "log-missing" };
  const current = fs.readFileSync(logPath);
  if (!current.subarray(0, DECISION_HEADER.length).equals(Buffer.from(DECISION_HEADER))) {
    return { ok: false, reason: "header-changed" };
  }
  const digest = typeof prior === "string" || Buffer.isBuffer(prior)
    ? { bytes: Buffer.byteLength(prior), sha256: createHash("sha256").update(prior).digest("hex") }
    : prior;
  if (!digest || !Number.isInteger(digest.bytes) || typeof digest.sha256 !== "string") {
    return { ok: false, reason: "prior-digest-invalid" };
  }
  if (current.length < digest.bytes) return { ok: false, reason: "log-truncated" };
  const prefix = createHash("sha256").update(current.subarray(0, digest.bytes)).digest("hex");
  if (prefix !== digest.sha256) return { ok: false, reason: "prior-rows-rewritten" };
  return { ok: true, reason: current.length === digest.bytes ? "unchanged" : "appended", bytes: current.length };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, ...keys) {
  const missing = keys.filter((key) => !options[key]);
  if (missing.length) throw new Error(`missing --${missing.join(", --")}`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const USAGE = `usage: merge-readback.mjs <command> [options]
  init-log  --log <tsv>
  plan      --stack <stack.json> --verdicts <verdicts.json> [--log <tsv>]
  readback  --repo <path> --merge-sha <sha> --verified-head <sha> [--verified-base <sha>] [--main <ref>]
            [--log <tsv> --pr <n> --verdict-ref <ref>]
  readback-run --repo <path> --merges <merges.json> --log <tsv> [--main <ref>]
  digest    --log <tsv>
  verify-log --log <tsv> --prior <digest.json>`;

export function runCli(argv, out = process.stdout) {
  const { command, options } = parseArgs(argv);
  const print = (value) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case "init-log": {
      required(options, "log");
      if (fs.existsSync(options.log) && fs.statSync(options.log).size > 0) throw new Error(`${options.log} already exists`);
      fs.mkdirSync(path.dirname(options.log), { recursive: true });
      fs.writeFileSync(options.log, DECISION_HEADER);
      return 0;
    }
    case "plan": {
      required(options, "stack", "verdicts");
      const plan = planContiguousVerified(readJson(options.stack), readJson(options.verdicts));
      if (options.log) {
        for (const entry of plan.land) {
          appendDecision(options.log, { ...entry, action: "plan-land", result: "verified-at-head" });
        }
        if (plan.stop) {
          appendDecision(options.log, { pr: plan.stop.pr, head_sha: plan.stop.head_sha, verdict_ref: plan.stop.verdict_ref, action: "plan-stop", result: `stop: ${plan.stop.reason}` });
        }
      }
      print(plan);
      return 0;
    }
    case "readback": {
      required(options, "repo", "merge-sha", "verified-head");
      if (options.log) required(options, "pr", "verdict-ref");
      const result = readBack({
        repo: options.repo,
        mergeSha: options["merge-sha"],
        verifiedHead: options["verified-head"],
        verifiedBase: options["verified-base"],
        mainRef: options.main ?? "main",
      });
      if (options.log) {
        const merge = { pr: options.pr, head_sha: options["verified-head"], verdict_ref: options["verdict-ref"], merge_sha: options["merge-sha"] };
        appendDecision(options.log, readBackRow(merge, result));
      }
      print(result);
      return result.tree_match ? 0 : 1;
    }
    case "readback-run": {
      required(options, "repo", "merges", "log");
      const run = readBackRun({ repo: options.repo, merges: readJson(options.merges), logPath: options.log, mainRef: options.main ?? "main" });
      print(run);
      return run.stop ? 1 : 0;
    }
    case "digest": {
      required(options, "log");
      print(logDigest(options.log));
      return 0;
    }
    case "verify-log": {
      required(options, "log", "prior");
      const result = verifyAppendOnly(options.log, readJson(options.prior));
      print(result);
      return result.ok ? 0 : 1;
    }
    default:
      throw new Error(`unknown command: ${command ?? "(none)"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`merge-readback: ${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  }
}
