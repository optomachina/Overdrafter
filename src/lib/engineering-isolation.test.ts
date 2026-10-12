import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Jarvis must never sit on the quoting critical path: only these entry points may reach the engineering area.
const srcRoot = path.resolve(import.meta.dirname, "..");
const appShells = ["main.tsx", "App.tsx"];
const allowedImporters = new Set([...appShells, "sample-plate-private.tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(srcRoot, file).split(path.sep).join("/");
}

function isEngineeringArea(file: string): boolean {
  return /^(features\/engineering\/|pages\/Engineering[^/]*$|lib\/engineering-[^/]*$)/.test(file);
}

function importedModules(file: string): { readonly target: string; readonly dynamic: boolean }[] {
  const source = readFileSync(file, "utf8");
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].flatMap((match) => {
    const specifier = match[1];
    const dynamic = match[0].includes("(");
    if (specifier.startsWith("@/")) return [{ target: specifier.slice(2), dynamic }];
    if (specifier.startsWith(".")) return [{ target: relative(path.resolve(path.dirname(file), specifier)), dynamic }];
    return [];
  });
}

function engineeringImports(file: string) {
  return importedModules(file).filter(({ target }) => isEngineeringArea(target.replace(/\.(ts|tsx)$/, "")));
}

describe("engineering area isolation", () => {
  const files = sourceFiles(srcRoot);

  it("keeps quoting and shared code free of engineering imports", () => {
    const offenders = files
      .map(relative)
      .filter((file) => !isEngineeringArea(file) && !allowedImporters.has(file))
      .flatMap((file) => engineeringImports(path.join(srcRoot, file)).map(({ target }) => `${file} -> ${target}`));
    expect(offenders).toEqual([]);
  });

  it.each(appShells)("lets %s reach engineering pages only through lazy dynamic imports", (shell) => {
    const staticImports = engineeringImports(path.join(srcRoot, shell)).filter(({ dynamic }) => !dynamic);
    expect(staticImports.map(({ target }) => target)).toEqual(["lib/engineering-workbench-access"]);
  });

  it("registers the hosted admin entry as its own lazy chunk", () => {
    const dynamicImports = engineeringImports(path.join(srcRoot, "App.tsx")).filter(({ dynamic }) => dynamic);
    expect(dynamicImports.map(({ target }) => target).sort()).toEqual([
      "pages/EngineeringAdminRoute",
      "pages/EngineeringInbox",
      "pages/EngineeringWorkbench",
    ]);
  });

  it("keeps the shared access helper free of engineering feature code", () => {
    expect(engineeringImports(path.join(srcRoot, "lib/engineering-workbench-access.ts"))).toEqual([]);
  });

  it("detects a violation when one is introduced", () => {
    expect(isEngineeringArea("features/engineering/engineering-inbox-client")).toBe(true);
    expect(isEngineeringArea("pages/EngineeringInbox")).toBe(true);
    expect(isEngineeringArea("pages/ClientQuotes")).toBe(false);
    expect(isEngineeringArea("features/quotes/service-intent")).toBe(false);
  });
});
