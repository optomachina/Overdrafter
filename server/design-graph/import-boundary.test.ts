import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findBoundaryViolations, formatReport, scanRepo } from "./import-boundary";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("design-graph import boundary", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixtureRepo(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "design-graph-boundary-"));
    tempRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
    return root;
  }

  it("G-5 real repo: channel and UI code reach workers only through the DesignGraph entry", () => {
    const report = scanRepo(repoRoot);
    console.log(formatReport(report));
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });

  it("G-5 fixture: fails when channel/UI code imports a worker or graph internals directly", () => {
    const root = fixtureRepo({
      "src/features/jarvis/Panel.tsx": [
        'import { DesignGraph } from "../../../server/design-graph";',
        'import { StubCadAgent } from "../../../server/design-graph/agents";',
        'import { runQuote } from "../../../worker/src/quoteRunner";',
        "",
      ].join("\n"),
      "api/jarvis.ts": 'export { DesignGraph } from "../server/design-graph/index";\nconst w = await import("../worker/src/cad");\n',
      "server/chatgpt/jarvis-channel.ts": 'import type { X } from "../../worker/src/types";\n',
      "src/lib/ok.ts": 'import { cn } from "@/lib/utils";\nimport { DesignGraph } from "../../server/design-graph/index.ts";\n',
    });
    const report = scanRepo(root);
    console.log(formatReport(report));
    expect(report.violations.map(({ file, line, reason }) => ({ file, line, reason }))).toEqual([
      { file: "api/jarvis.ts", line: 2, reason: "worker_import" },
      { file: "server/chatgpt/jarvis-channel.ts", line: 1, reason: "worker_import" },
      { file: "src/features/jarvis/Panel.tsx", line: 2, reason: "design_graph_internal_import" },
      { file: "src/features/jarvis/Panel.tsx", line: 3, reason: "worker_import" },
    ]);
  });

  it("G-5 pure scan resolves multiline imports and the @/ alias", () => {
    const violations = findBoundaryViolations([
      {
        path: "src/a.ts",
        content: 'import {\n  a,\n  b,\n} from "../worker/src/x";\nexport * from "@/../server/design-graph/graph";\n',
      },
    ]);
    expect(violations.map((v) => [v.line, v.resolved, v.reason])).toEqual([
      [1, "worker/src/x", "worker_import"],
      [5, "server/design-graph/graph", "design_graph_internal_import"],
    ]);
  });
});
