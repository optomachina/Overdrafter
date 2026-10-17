import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// CS-14 static half: DesignGraph is the only exit to work, so nothing under
// src/features/jarvis/** may import a worker or queue module, or reach outside the feature.
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const jarvisRoot = path.join(repoRoot, "src/features/jarvis");

const WORKER_OR_QUEUE = /(^|\/)(worker|workers|queue|queues)(\/|$)|worker|queue|bullmq|pg-boss/i;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function resolveSpecifier(file: string, specifier: string): string {
  if (specifier.startsWith("@/")) return path.join("src", specifier.slice(2));
  if (specifier.startsWith(".")) return path.relative(repoRoot, path.resolve(path.dirname(file), specifier));
  return specifier;
}

/** Returns one violation per import that leaves the feature or names a worker/queue module. */
export function boundaryViolations(file: string, source: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const relativeFile = path.relative(repoRoot, file).split(path.sep).join("/");
  return [...source.matchAll(pattern)].flatMap((match) => {
    const target = resolveSpecifier(file, match[1]).split(path.sep).join("/");
    if (WORKER_OR_QUEUE.test(target)) return [`${relativeFile} -> ${target} (worker/queue module)`];
    if (!target.startsWith("src/features/jarvis/")) return [`${relativeFile} -> ${target} (outside src/features/jarvis)`];
    return [];
  });
}

describe("Jarvis import boundary (CS-14)", () => {
  const files = sourceFiles(jarvisRoot);

  it("scans the jarvis feature sources", () => {
    expect(files.map((file) => path.relative(jarvisRoot, file)).sort()).toEqual(
      expect.arrayContaining(["core/conversation-service.ts", "core/types.ts", "channels/index.ts", "channels/test-adapter.ts"]),
    );
  });

  it("finds no worker/queue imports and no imports outside src/features/jarvis", () => {
    const violations = files.flatMap((file) => boundaryViolations(file, readFileSync(file, "utf8")));
    expect(violations).toEqual([]);
  });

  it.each([
    ['import { claim } from "../../../../worker/src/queue";', "worker/queue module"],
    ['import { enqueue } from "@/lib/engineering-queue";', "worker/queue module"],
    ['const w = await import("../../../server/engineering/native-stop-workflow");', "outside src/features/jarvis"],
    ['import { Queue } from "bullmq";', "worker/queue module"],
    ['import { createClient } from "@supabase/supabase-js";', "outside src/features/jarvis"],
  ])("fails on a planted violation: %s", (source, kind) => {
    const planted = path.join(jarvisRoot, "core/planted.ts");
    expect(boundaryViolations(planted, source)).toEqual([expect.stringContaining(kind)]);
  });
});
