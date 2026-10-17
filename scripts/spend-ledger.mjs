/** Filesystem/gh adapter for the pure spend ledger module. */
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UsageError, usageToLedger, ledgerKey, parseLines, validateLedger, mergeLedger, jsonl, weeklyReport, parseAttribution, exportEvals, markdownReport } from "./lib/spend-ledger.mjs";

const STANDARD_DIRECTORIES = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const binaries = new Map();
/** Resolve executable names only in fixed standard locations, once per binary. */
export function resolveBin(name) {
  if (!['git', 'gh'].includes(name)) return null;
  if (!binaries.has(name)) {
    let found = null;
    for (const directory of STANDARD_DIRECTORIES) {
      const candidate = path.join(directory, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); found = candidate; break; }
      catch { /* Try the next standard location. */ }
    }
    binaries.set(name, found);
  }
  return binaries.get(name);
}
const executableEnvironment = () => ({ PATH: "/usr/bin:/bin", HOME: os.homedir() });

const HELP = `Usage: spend-ledger <collect|weekly|export-evals> [options]
collect --input FILE (repeatable) [--ledger FILE] [--dry-run]
weekly --from YYYY-MM-DD --to YYYY-MM-DD [--ledger FILE (repeatable)]
  [--prs-json FILE | --repo OWNER/REPO] [--attribution FILE]
  [--min-sample N] [--generated-at ISO] [--format json|md]
export-evals [--ledger FILE (repeatable)] [--out FILE]
--help prints this usage.\n`;
const allowed = {
  collect: ["input", "ledger", "dry-run"],
  weekly: ["ledger", "from", "to", "prs-json", "repo", "attribution", "min-sample", "generated-at", "format"],
  "export-evals": ["ledger", "out"],
};
/** Execute with injected streams, paths and gh runner. No network needed in tests. */
export function main(args, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  try {
    if (args.includes("--help")) { stdout.write(HELP); return 0; }
    const [command, ...rest] = args;
    if (!allowed[command]) throw new UsageError("expected collect, weekly or export-evals");
    const options = {};
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i].slice(2);
      if (!rest[i].startsWith("--") || !allowed[command].includes(key)) throw new UsageError("unknown argument");
      const value = key === "dry-run" ? true : rest[++i];
      if (value === undefined || (typeof value === "string" && value.startsWith("--"))) throw new UsageError(`--${key} needs a value`);
      if (options[key] && !["input", "ledger"].includes(key)) throw new UsageError(`duplicate --${key}`);
      options[key] = [...(options[key] ?? []), value];
    }
    const one = (key) => options[key]?.[0];
    let repoRoot = deps.repoRoot;
    if (!repoRoot) {
      try {
        const git = (deps.resolveBin ?? resolveBin)("git");
        if (!git) throw new Error("git unavailable");
        repoRoot = (deps.execFile ?? execFileSync)(git, ["rev-parse", "--show-toplevel"], { cwd, env: executableEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      }
      catch { repoRoot = fileURLToPath(new URL("../", import.meta.url)); }
    }
    const resolve = (file) => path.resolve(cwd, file);
    const ledgerFiles = (options.ledger ?? [path.join(repoRoot, "evals/spend-ledger/ledger.jsonl")]).map(resolve);
    const read = (file) => fs.readFileSync(file, "utf8");
    const readJSON = (file) => {
      try { return JSON.parse(read(file)); } catch (error) {
        if (error instanceof SyntaxError) throw new UsageError(`${file}:1: invalid JSON`);
        throw error;
      }
    };
    const load = (missingOK = false) => ledgerFiles.flatMap((file) => {
      if (missingOK && !fs.existsSync(file)) return [];
      return parseLines(read(file), file, validateLedger);
    });
    const writeAtomic = (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const directory = fs.mkdtempSync(`${file}.`);
      const temporary = path.join(directory, "pending");
      try {
        fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    };
    if (command === "collect") {
      if (!options.input?.length || ledgerFiles.length !== 1) throw new UsageError("collect requires --input and one ledger");
      const incoming = options.input.flatMap((file) => {
        const seen = new Set();
        return parseLines(read(resolve(file)), file, (record, location) => {
          const row = usageToLedger(record, location);
          const key = ledgerKey(row);
          if (seen.has(key)) throw new UsageError(`${location}: duplicate ledger key`);
          seen.add(key);
          return row;
        });
      });
      const merged = mergeLedger(load(true), incoming);
      if (!one("dry-run")) writeAtomic(ledgerFiles[0], jsonl(merged));
      stdout.write(`${JSON.stringify({ records: merged.length, valued: merged.filter((r) => r.usd !== null).length, unvalued: merged.filter((r) => r.usd === null).length, dryRun: !!one("dry-run") })}\n`);
    } else if (command === "export-evals") {
      const rows = mergeLedger([], load());
      const exported = exportEvals(rows);
      const output = jsonl(exported);
      const unvalued = rows.filter((r) => r.usd === null).length;
      if (one("out")) writeAtomic(resolve(one("out")), output); else stdout.write(output);
      stderr.write(`Skipped ${unvalued} unvalued lines\n`);
      if (!exported.length && unvalued > 0) {
        stderr.write(`No valued records to export; ${unvalued} unvalued\n`);
        return 3;
      }
    } else {
      if (!one("from") || !one("to")) throw new UsageError("weekly requires --from and --to");
      if (one("prs-json") && one("repo")) throw new UsageError("choose --prs-json or --repo");
      if (one("format") && !["json", "md"].includes(one("format"))) throw new UsageError("invalid format");
      const rows = load();
      const attribution = one("attribution") ? parseAttribution(readJSON(resolve(one("attribution")))) : {};
      const reportOptions = { ledger: rows, prs: [], from: one("from"), to: one("to"), attribution,
        minSample: one("min-sample") === undefined ? 5 : Number(one("min-sample")), generatedAt: one("generated-at") };
      // Validate before invoking gh, including search dates.
      weeklyReport(reportOptions);
      let prs;
      if (one("prs-json")) prs = readJSON(resolve(one("prs-json")));
      else {
        const ghArgs = ["pr", "list", ...(one("repo") ? ["--repo", one("repo")] : []), "--state", "merged", "--base", "main", "--search", `merged:${one("from")}..${one("to")}`, "--limit", "1000", "--json", "number,title,mergedAt,labels,headRefName,body,author"];
        const runGh = deps.runGh ?? ((argv) => {
          const gh = (deps.resolveBin ?? resolveBin)("gh");
          if (!gh) throw new UsageError("gh was not found in standard locations; use --prs-json");
          return (deps.execFile ?? execFileSync)(gh, argv, { cwd, env: executableEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        });
        const response = runGh(ghArgs);
        try { prs = typeof response === "string" || Buffer.isBuffer(response) ? JSON.parse(String(response)) : response; }
        catch { throw new Error("gh returned invalid JSON"); }
        if (Array.isArray(prs) && prs.length >= 1000) throw new Error("gh result reached 1000; use --prs-json to avoid truncation");
      }
      const report = weeklyReport({ ...reportOptions, prs, sources: { ledgerFiles: ledgerFiles.length, ledgerLines: rows.length, prSource: one("prs-json") ? "prs-json" : "gh", attributionLoaded: !!one("attribution") } });
      stdout.write(one("format") === "md" ? markdownReport(report) : `${JSON.stringify(report, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    // Do not echo file contents or gh stderr (which may contain credentials).
    stderr.write(`${error instanceof UsageError ? error.message : "File or gh operation failed"}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
