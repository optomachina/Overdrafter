import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function parseWorktreePorcelain(text) {
  return text.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const entry = { prunable: false };
    for (const line of block.split("\n")) {
      const [key, ...parts] = line.split(" ");
      const value = parts.join(" ");
      if (key === "worktree") entry.path = value;
      else if (key === "HEAD") entry.head = value;
      else if (key === "branch") entry.branch = value.replace("refs/heads/", "");
      else if (key === "detached") entry.detached = true;
      else if (key === "prunable") {
        entry.prunable = true;
        entry.prunableReason = value;
      }
    }
    return entry;
  });
}

function runGit(cwd, args) {
  try {
    return {
      ok: true,
      output: execFileSync("/usr/bin/git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readMetadata(metadataPath) {
  if (!metadataPath) return {};
  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("worktree metadata must be an object keyed by absolute path");
  }
  return parsed;
}

export function inventoryWorktrees(cwd = process.cwd(), { baseRef = "origin/main", metadataPath = "" } = {}) {
  const raw = execFileSync("/usr/bin/git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  const metadata = readMetadata(metadataPath);
  const worktrees = parseWorktreePorcelain(raw).map((entry) => {
    const details = metadata[entry.path] ?? {};
    const status = runGit(entry.path, ["status", "--porcelain=v1"]);
    const unique = runGit(entry.path, ["log", "--format=%H%x09%s", `${baseRef}..HEAD`]);
    return {
      ...entry,
      ownerThread: details.ownerThread ?? null,
      evidenceRefs: Array.isArray(details.evidenceRefs) ? details.evidenceRefs : [],
      dirty: status.ok ? Boolean(status.output) : null,
      dirtyEntries: status.ok && status.output ? status.output.split("\n") : [],
      uniqueCommits: unique.ok && unique.output ? unique.output.split("\n").map((line) => {
        const [sha, ...subject] = line.split("\t");
        return { sha, subject: subject.join("\t") };
      }) : [],
      inspectionErrors: [status.ok ? null : status.error, unique.ok ? null : unique.error].filter(Boolean),
    };
  });
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    baseRef,
    cleanupAuthorized: false,
    worktrees,
  };
}

if (process.argv[1]?.endsWith("inventory-worktrees.mjs")) {
  const args = process.argv.slice(2);
  const valueAfter = (flag, fallback = "") => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  console.log(JSON.stringify(inventoryWorktrees(process.cwd(), {
    baseRef: valueAfter("--base", "origin/main"),
    metadataPath: valueAfter("--metadata"),
  }), null, 2));
}
