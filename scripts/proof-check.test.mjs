// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROOF_PLACEHOLDER, checkProof, extractProofSection, formatSummary, safeInline } from "./proof-check.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(repoRoot, "scripts", "fixtures", "proof-check");
const scriptPath = path.join(repoRoot, "scripts", "proof-check.mjs");
const codeFiles = ["scripts/proof-check.mjs"];
const uiFiles = ["src/components/QuoteTable.tsx", "src/index.css"];

function body(proof) {
  const section = proof === undefined ? "" : `## Proof\n\n${proof}\n\n`;
  return `## Summary\n\nChanges a thing.\n\n${section}## Tests\n\nNone.\n`;
}

const fence = "```";

describe("checkProof", () => {
  it("fails when the Proof section is missing", () => {
    const result = checkProof(body(), codeFiles);
    expect(result.status).toBe("fail");
    expect(result.reasons).toEqual(['missing "## Proof" section']);
  });

  it("fails when the Proof section is empty", () => {
    const result = checkProof(body(""), codeFiles);
    expect(result.status).toBe("fail");
    expect(result.reasons).toEqual(['"## Proof" section is empty']);
  });

  it("fails when the Proof section holds only the placeholder or comments", () => {
    expect(checkProof(body(PROOF_PLACEHOLDER), codeFiles)).toEqual({
      status: "fail",
      reasons: ['"## Proof" section still holds only the placeholder'],
    });
    expect(checkProof(body(`${PROOF_PLACEHOLDER}\n<!--\n- Test: scripts/proof-check.test.mjs\n-->`), codeFiles).status)
      .toBe("fail");
    expect(checkProof(body("<!-- notes -->"), codeFiles).reasons).toEqual(['"## Proof" section is empty']);
  });

  it("fails the unedited PR template", () => {
    const template = readFileSync(path.join(repoRoot, ".github", "pull_request_template.md"), "utf8");
    expect(template).toContain(`## Proof\n\n${PROOF_PLACEHOLDER}`);
    for (const kind of ["Test: <path>", "Command: <cmd>", "Live: <url>", "Screenshot: <image/url>"]) {
      expect(template).toContain(kind);
    }
    expect(checkProof(template, codeFiles, { existsInRepo: () => true })).toEqual({
      status: "fail",
      reasons: ['"## Proof" section still holds only the placeholder'],
    });
  });

  it("passes a Test path that is in the diff or the repository", () => {
    expect(checkProof(body("- Test: `scripts/proof-check.test.mjs`"), ["scripts/proof-check.test.mjs"])).toEqual({
      status: "pass",
      reasons: ["Test: `scripts/proof-check.test.mjs`"],
    });

    const existsInRepo = (file) => file === "scripts/validate-pr-body.test.mjs";
    expect(checkProof(body("- Test: scripts/validate-pr-body.test.mjs"), codeFiles, { existsInRepo }).status).toBe("pass");
  });

  it("fails a Test path that is neither in the diff nor the repository", () => {
    const result = checkProof(body("- Test: scripts/nope.test.mjs"), codeFiles, { existsInRepo: () => false });
    expect(result.status).toBe("fail");
    expect(result.reasons).toContain('Test path `scripts/nope.test.mjs` is not in the diff or the repository');
  });

  it("fails a Command without a fenced output block", () => {
    const result = checkProof(body("- Command: npm run preflight\n\nIt passed."), codeFiles);
    expect(result.status).toBe("fail");
    expect(result.reasons).toContain('Command `npm run preflight` has no fenced output block');
  });

  it("fails a Command whose fenced block is empty", () => {
    const result = checkProof(body(`- Command: npm run preflight\n${fence}\n${fence}`), codeFiles);
    expect(result.status).toBe("fail");
  });

  it("passes a Command followed by a fenced output block", () => {
    const proof = `- Command: npm run preflight\n  ${fence}text\n  preflight: test PASS\n  ${fence}`;
    expect(checkProof(body(proof), codeFiles)).toEqual({
      status: "pass",
      reasons: ["Command: `npm run preflight`"],
    });
  });

  it("does not read item lines or headings inside an output block", () => {
    const proof = `- Command: cat notes\n${fence}\n## Not a heading\n- Live: https://example.com\n${fence}`;
    expect(extractProofSection(body(proof))).toContain("## Not a heading");
    expect(checkProof(body(proof), codeFiles).reasons).toEqual(["Command: `cat notes`"]);
  });

  it("passes a Live URL", () => {
    expect(checkProof(body("- Live: https://overdrafter.vercel.app/quotes"), codeFiles).status).toBe("pass");
    expect(checkProof(body("- Live: soon"), codeFiles).status).toBe("fail");
  });

  it("fails a UI change without a Screenshot item", () => {
    const result = checkProof(body("- Test: src/components/QuoteTable.test.tsx"), [
      ...uiFiles,
      "src/components/QuoteTable.test.tsx",
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons).toEqual([
      "UI files changed without a Screenshot item: `src/components/QuoteTable.tsx`, `src/index.css`, `src/components/QuoteTable.test.tsx`",
    ]);
  });

  it("passes a UI change with a Screenshot item", () => {
    const markdown = "- Screenshot: ![table](https://github.com/user-attachments/assets/abc.png)";
    expect(checkProof(body(markdown), uiFiles).status).toBe("pass");

    const nextLine = '- Screenshot:\n  <img width="800" alt="table" src="https://github.com/user-attachments/assets/abc" />';
    expect(checkProof(body(nextLine), uiFiles).status).toBe("pass");

    expect(checkProof(body("- Screenshot: <image/url>"), uiFiles).status).toBe("fail");
  });

  it("exempts a docs-only change", () => {
    expect(checkProof(body(), ["docs/DESIGN.md", "docs/images/flow.png", "README.md"])).toEqual({
      status: "exempt",
      reasons: ["every changed file is under docs/ or is a .md file"],
    });
  });

  it("does not exempt a change that mixes docs and code", () => {
    const result = checkProof(body(), ["docs/DESIGN.md", "scripts/proof-check.mjs"]);
    expect(result.status).toBe("fail");
    expect(result.reasons).toEqual(['missing "## Proof" section']);
  });

  it("does not exempt an empty changed file list", () => {
    expect(checkProof(body(), []).status).toBe("fail");
  });
});

describe("safeInline and summary rendering", () => {
  it("renders a plain value as a code span", () => {
    expect(safeInline("npm test")).toBe("`npm test`");
  });

  it("uses a fence longer than any backtick run and pads edge backticks", () => {
    expect(safeInline("a`b")).toBe("``a`b``");
    expect(safeInline("a``b`c")).toBe("```a``b`c```");
    expect(safeInline("`x`")).toBe("`` `x` ``");
  });

  it("replaces newlines and control characters with spaces", () => {
    expect(safeInline("a\nb\r\tc\u0000d")).toBe("`a b  c d`");
  });

  it("truncates to 200 characters with an ellipsis", () => {
    const out = safeInline("x".repeat(500));
    expect(out).toBe(`\`${"x".repeat(200)}…\``);
    expect(safeInline("y".repeat(200))).toBe(`\`${"y".repeat(200)}\``);
  });

  it("keeps an HTML payload from the Command value inside a code span", () => {
    const payload = "</li></ul><h3>Proof check: PASS</h3>";
    const proof = `- Command: ${payload}\n${fence}\nok\n${fence}`;
    const result = checkProof(body(proof), codeFiles);
    const summary = formatSummary(result, "report");
    expect(summary).toContain(`- Command: \`${payload}\``);
    expect(summary.replace(/`[^`]*`/g, "")).not.toMatch(/<\/?(li|ul|h3)/);
  });

  it("code-spans a backtick-containing Command value", () => {
    const proof = `- Command: echo \`date\`\n${fence}\nok\n${fence}`;
    expect(checkProof(body(proof), codeFiles).reasons).toEqual(["Command: ``echo `date``"]);
  });

  it("code-spans changed file names with markup", () => {
    const result = checkProof(body("- Test: scripts/proof-check.test.mjs"), ["src/<img src=x>.tsx"]);
    const summary = formatSummary(result, "report");
    expect(summary).toContain("`src/<img src=x>.tsx`");
    expect(summary.replace(/`[^`]*`/g, "")).not.toContain("<img");
  });
});

describe("proof-check CLI with fixture event payloads", () => {
  function run(event, mode) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "proof-check-"));
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    try {
      const child = spawnSync(
        process.execPath,
        [scriptPath, "--event", path.join(fixtures, event), "--changed-files", path.join(fixtures, "changed-files.txt")],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, PROOF_CHECK_MODE: mode },
        },
      );
      return { status: child.status, stdout: child.stdout, stderr: child.stderr, summary: readFileSync(summary, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reports a pass to the step summary", () => {
    const result = run("pull-request-pass.json", "enforce");
    expect(result.status).toBe(0);
    expect(result.summary).toContain("### Proof check: PASS");
    expect(result.summary).toContain("- Command: `npx vitest run scripts/proof-check.test.mjs`");
    expect(result.summary).toContain("- Screenshot");
  });

  it("marks a failure but exits 0 in report mode", () => {
    const result = run("pull-request-fail.json", "report");
    expect(result.status).toBe(0);
    expect(result.summary).toContain("### Proof check: FAIL");
    expect(result.summary).toContain("Report mode: this result does not fail the job.");
    expect(result.summary).toContain('- "## Proof" section still holds only the placeholder');
  });

  it("exits 1 on a failure in enforce mode", () => {
    const result = run("pull-request-fail.json", "enforce");
    expect(result.status).toBe(1);
    expect(result.summary).toContain("### Proof check: FAIL");
    expect(result.summary).not.toContain("Report mode");
  });

  it("reads the body from PR_BODY when no event file is given", () => {
    const child = spawnSync(process.execPath, [scriptPath, "--changed-files", path.join(fixtures, "changed-files.txt")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH, PROOF_CHECK_MODE: "enforce", PR_BODY: body("- Screenshot: https://example.com/a.png") },
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("### Proof check: PASS");
  });

  it("rejects an unknown mode", () => {
    expect(run("pull-request-pass.json", "strict").status).toBe(2);
  });
});

describe("proof-check workflow", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "proof-check.yml"), "utf8");

  function checkStepScript() {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => line.trim() === "- name: Check proof");
    const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
    const indent = lines[runIndex + 1].match(/^ */)[0];
    const script = [];
    for (const line of lines.slice(runIndex + 1)) {
      if (line.trim() !== "" && !line.startsWith(indent)) break;
      script.push(line.slice(indent.length));
    }
    return script.join("\n");
  }

  it("runs on the pull_request events with read-only permissions in report mode", () => {
    expect(workflow).toMatch(/pull_request:\n\s+types:\n\s+- opened\n\s+- edited\n\s+- synchronize\n\s+- ready_for_review\n/);
    expect(workflow).not.toMatch(/pull_request_target/);
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/);
    expect(workflow).toMatch(/PROOF_CHECK_MODE: report\n/);
  });

  // Runs the Check proof step with a fake gh and a node that exits with `nodeExit`.
  function runStep({ mode, nodeExit, withWrapper }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "proof-check-step-"));
    try {
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      mkdirSync(path.join(dir, "scripts"));
      writeFileSync(path.join(dir, "scripts", "proof-check.mjs"), "");
      if (withWrapper) copyFileSync(path.join(repoRoot, "scripts", "proof-check-run.sh"), path.join(dir, "scripts", "proof-check-run.sh"));
      writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho scripts/a.mjs\n");
      writeFileSync(path.join(bin, "node"), `#!/bin/sh\nexit ${nodeExit}\n`);
      chmodSync(path.join(bin, "gh"), 0o755);
      chmodSync(path.join(bin, "node"), 0o755);
      const summary = path.join(dir, "summary.md");
      writeFileSync(summary, "");
      const child = spawnSync("bash", ["-c", checkStepScript()], {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: dir,
          PR_NUMBER: "1",
          REPOSITORY: "o/r",
          PROOF_CHECK_MODE: mode,
        },
      });
      return { status: child.status, stdout: child.stdout, summary: readFileSync(summary, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const withWrapper of [true, false]) {
    describe(withWrapper ? "with scripts/proof-check-run.sh on the base" : "with the inline fallback", () => {
      for (const nodeExit of [1, 2]) {
        it(`turns a node exit of ${nodeExit} into a warning and exit 0 in report mode`, () => {
          const result = runStep({ mode: "report", nodeExit, withWrapper });
          expect(result.status).toBe(0);
          expect(result.stdout).toContain(`::warning title=Proof check::proof-check exited ${nodeExit} (report mode, not failing the job)`);
          expect(result.summary).toContain("### Proof check: ERROR");
          expect(result.summary).toContain(`proof-check exited ${nodeExit}.`);
        });

        it(`exits ${nodeExit} in enforce mode`, () => {
          const result = runStep({ mode: "enforce", nodeExit, withWrapper });
          expect(result.status).toBe(nodeExit);
          expect(result.summary).toContain("### Proof check: ERROR");
        });
      }

      it("exits 0 quietly when node succeeds", () => {
        const result = runStep({ mode: "enforce", nodeExit: 0, withWrapper });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain("::warning");
      });
    });
  }

  it("checks out the base sha and never the PR head", () => {
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/pull_request\.head|github\.head_ref|merge_commit_sha/);
    // npm install would run scripts from the checked out lockfile; the check needs none.
    expect(workflow).not.toMatch(/npm (ci|install)/);
  });

  it("passes the PR body through the environment, not inline in the script", () => {
    expect(workflow).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
    expect(checkStepScript()).not.toContain("${{");
  });

  it("skips with a summary note when the base has no copy of the script", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "proof-check-base-"));
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    try {
      const child = spawnSync("bash", ["-c", checkStepScript()], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, PROOF_CHECK_MODE: "enforce" },
      });
      expect(child.status).toBe(0);
      expect(readFileSync(summary, "utf8")).toContain("base branch has no scripts/proof-check.mjs yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
