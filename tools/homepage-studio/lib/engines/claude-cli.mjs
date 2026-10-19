// Local engine: spawns the Claude CLI headlessly. Never fabricates output: if the
// CLI is missing or not logged in, the job is BLOCKED with a specific message.
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { EngineError } from "./errors.mjs";
import { buildBrief } from "../brief.mjs";
import path from "node:path";

export const NOT_LOGGED_IN = "Claude CLI is not logged in: run `claude auth login`";
export const NOT_INSTALLED = "Claude CLI was not found on PATH: install Claude Code, then run `claude auth login`";

export function defaultProbe(bin = "claude") {
  return () =>
    new Promise((resolve) => {
      execFile(bin, ["auth", "status"], { timeout: 15_000 }, (err, stdout) => {
        if (err && err.code === "ENOENT") return resolve({ installed: false, loggedIn: false });
        try {
          const j = JSON.parse(String(stdout));
          resolve({ installed: true, loggedIn: j.loggedIn === true, detail: j.authMethod });
        } catch {
          resolve({ installed: true, loggedIn: false, detail: "unreadable status" });
        }
      });
    });
}

export function buildArgs({ brief, model = "sonnet", skillDir = null, kind = "asset", maxBudgetUsd = null }) {
  // The prompt is positional and goes right after -p because --add-dir is variadic.
  const args = ["-p", brief, "--no-session-persistence", "--output-format", "json", "--model", model];
  args.push("--allowedTools", kind === "asset" ? "Read,Write,Edit,Glob,Grep" : "Read");
  if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));
  if (skillDir) args.push("--add-dir", skillDir);
  return args;
}

export function killTree(child, grace = 3000) {
  if (!child || child.killed || child.exitCode !== null) return;
  const send = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), grace).unref?.();
}

export function parseCopyResult(result) {
  const s = String(result || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const j = JSON.parse(s);
    if (typeof j.text === "string" && j.text.trim()) return j.text.trim();
  } catch {
    /* fall through */
  }
  throw new EngineError("invalid_output", 'Claude did not return the requested {"text": ...} JSON.');
}

export function createClaudeCliEngine({ probe = defaultProbe(), spawnImpl = nodeSpawn, bin = "claude", unavailableReason = null, budgetUsd = 3, env = process.env } = {}) {
  return {
    id: "claude-cli",
    label: "Claude CLI (local)",
    description: "Runs `claude -p` on this machine with a restricted toolset.",
    inline: true,
    usesSkills: true,
    async available() {
      if (unavailableReason) return { ok: false, message: unavailableReason };
      const p = await probe();
      if (!p.installed) return { ok: false, message: NOT_INSTALLED };
      if (!p.loggedIn) return { ok: false, message: NOT_LOGGED_IN };
      return { ok: true, message: "" };
    },
    async run(ctx) {
      const brief = buildBrief({
        kind: ctx.kind,
        tool: ctx.tool && ctx.tool.entryPath ? { entryPath: ctx.tool.entryPath } : null,
        section: ctx.section,
        currentCopy: ctx.currentCopy,
        prompt: ctx.prompt,
        currentText: ctx.currentText,
        fieldLabel: ctx.field?.label,
        budget: { minutes: Math.round((ctx.timeoutMs || 1_200_000) / 60_000), usd: budgetUsd },
      });
      const args = buildArgs({ brief, model: ctx.model || "sonnet", skillDir: ctx.tool?.dirPath || null, kind: ctx.kind, maxBudgetUsd: budgetUsd });
      ctx.onLog?.(`claude-cli: model=${ctx.model || "sonnet"} skill=${ctx.tool?.id || "none"}`);
      const child = spawnImpl(bin, args, { cwd: ctx.outDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
      let out = "";
      let errBuf = "";
      child.stdout.on("data", (d) => {
        out += d;
        ctx.onLog?.(`stdout ${String(d).length} bytes`);
      });
      child.stderr.on("data", (d) => {
        errBuf += d;
        for (const line of String(d).split("\n").filter(Boolean)) ctx.onLog?.(`stderr: ${line}`);
      });
      const onAbort = () => killTree(child);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal?.aborted) onAbort();
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      }).finally(() => ctx.signal?.removeEventListener("abort", onAbort));
      if (ctx.signal?.aborted) throw new EngineError("failed", "aborted");
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        throw new EngineError("failed", `Claude exited with code ${code} and no JSON result. ${errBuf.slice(-400)}`.trim());
      }
      if (json.is_error || code !== 0) {
        throw new EngineError("failed", `Claude reported an error: ${String(json.result || errBuf).slice(0, 400)}`);
      }
      const usage = { modelUsage: json.modelUsage || null, total_cost_usd: json.total_cost_usd ?? null, duration_ms: json.duration_ms ?? null, num_turns: json.num_turns ?? null };
      const model = json.modelUsage ? Object.keys(json.modelUsage).join(", ") : ctx.model || "unknown";
      if (ctx.kind === "copy") return { text: parseCopyResult(json.result), model, usage };
      return { model, usage };
    },
  };
}

export function toolPaths(tool) {
  if (!tool || !tool.resolvedPath) return null;
  return { id: tool.id, dirPath: tool.resolvedPath, entryPath: path.join(tool.resolvedPath, tool.entry || "SKILL.md") };
}
