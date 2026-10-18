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

// Exactly two package allowances (OVD-804); everything else stays a violation:
// `react` only inside src/features/jarvis/thread/, and `@google/model-viewer` only in
// the single lazy loader file. Server, worker and other package imports remain forbidden.
// The allowance applies only to a RAW bare specifier: a relative path or an "@/" alias that
// merely resolves to the string "react" (for example "../../../../react" or "@/../react")
// is not the package and never gets it, so the raw specifier must equal the resolved target.
const THREAD_DIR = "src/features/jarvis/thread/";
const MODEL_VIEWER_LOADER = "src/features/jarvis/thread/model-loader.ts";

export function isAllowedPackageImport(relativeFile: string, target: string, rawSpecifier: string): boolean {
  if (rawSpecifier !== target) return false;
  if (target === "react") return relativeFile.startsWith(THREAD_DIR) && !relativeFile.slice(THREAD_DIR.length).includes("..");
  if (target === "@google/model-viewer") return relativeFile === MODEL_VIEWER_LOADER;
  return false;
}

/** Returns one violation per import that leaves the feature or names a worker/queue module. */
export function boundaryViolations(file: string, source: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const relativeFile = path.relative(repoRoot, file).split(path.sep).join("/");
  return [...source.matchAll(pattern)].flatMap((match) => {
    const target = resolveSpecifier(file, match[1]).split(path.sep).join("/");
    if (isAllowedPackageImport(relativeFile, target, match[1])) return [];
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

  it.each([
    ["core/planted.ts", 'import { useState } from "react";'],
    ["channels/planted.tsx", 'import React from "react";'],
    ["planted.ts", 'import { useState } from "react";'],
    ["thread/planted.ts", 'import "@google/model-viewer";'],
    ["thread/sub/model-loader.ts", 'export const load = () => import("@google/model-viewer");'],
    ["core/model-loader.ts", 'export const load = () => import("@google/model-viewer");'],
    ["thread/planted.ts", 'import { createRoot } from "react-dom/client";'],
    ["thread/planted.ts", 'import { jsx } from "react/jsx-runtime";'],
    ["thread/planted.ts", 'import * as THREE from "three";'],
    ["thread/planted.ts", 'import { createClient } from "@supabase/supabase-js";'],
    ["thread/model-loader.ts", 'import { useState } from "preact/hooks";'],
    ["thread/model-loader.ts", 'import "@google/model-viewer-effects";'],
    ["thread-evil/planted.ts", 'import { useState } from "react";'],
    ["core/thread/planted.ts", 'import { useState } from "react";'],
    ["Thread/planted.ts", 'import { useState } from "react";'],
    ["thread/model-loader-evil.ts", 'import "@google/model-viewer";'],
    ["thread/Model-Loader.ts", 'import "@google/model-viewer";'],
    ["thread/planted.ts", 'import { useState } from "../../../../react";'],
    ["thread/model-loader.ts", 'import "../../../../@google/model-viewer";'],
    // resolveSpecifier maps "@/../react" to the bare string "react", so this alias case can occur.
    ["thread/planted.ts", 'import { useState } from "@/../react";'],
  ])("keeps the allowances narrow: %s importing %s is a violation", (file, source) => {
    const planted = path.join(jarvisRoot, file);
    expect(boundaryViolations(planted, source)).toEqual([expect.stringContaining("outside src/features/jarvis")]);
  });

  it.each([
    ["thread/planted.tsx", 'import { useState } from "react";'],
    ["thread/model-loader.ts", 'export const load = () => import("@google/model-viewer");'],
    ["thread/planted.tsx", 'import React, { useState } from "react";'],
  ])("permits exactly the two allowances: %s importing %s", (file, source) => {
    expect(boundaryViolations(path.join(jarvisRoot, file), source)).toEqual([]);
  });
});
