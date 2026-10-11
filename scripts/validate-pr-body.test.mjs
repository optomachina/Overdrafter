// @vitest-environment node

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_GO_LIVE_HEADING,
  PROVIDER_GO_LIVE_PATH_PATTERNS,
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  main,
  matchesProviderGoLivePath,
  parseChangedFiles,
  touchesProviderGoLivePath,
  validatePrBody,
} from "./validate-pr-body.mjs";

function buildValidPrBody() {
  return `
## Summary

Adds a pull-request body validator and documents the handoff expectation.

## Problem

PR descriptions were inconsistently filled out, so reviewers had to chase missing verification and risk context.

## Scope

- Adds a local validator script and a pull_request CI job.
- Updates workflow docs and repo-local PR skills.
- Does not change application runtime behavior.

## Verification

- [x] narrower commands were used intentionally and are listed below

Commands run:

\`\`\`bash
npm run test -- scripts/validate-pr-body.test.mjs
./scripts/symphony-preflight.sh
\`\`\`

Results:

- [x] all listed verification passed
- validator accepts a complete PR body and rejects template placeholders

Baseline failures or exceptions:

None.

## Tests

- Added unit coverage for valid, missing-section, placeholder, and empty-section cases.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

- The validator could reject a PR body that uses the wrong headings.
- Roll back by removing the job and validator script if it becomes too noisy.

## Documentation

- [x] Docs updated

Details:

Updated contributor workflow docs and Codex skill instructions.
`;
}

const ENVELOPE_FILES = ["test-fixtures/provider-dispatch-envelope/v1.json"];

const EVIDENCE = {
  "provider-check": "`npm run provider:check` passed on 1a2b3c4d",
  "envelope-reviewer": "Jane Doe reviewed fictiv-quote-envelope.v1, https://linear.app/overdrafter/issue/OVD-404",
  "worker-secret": "`FICTIV_STORAGE_STATE_SECRET_NAME` created in Secret Manager",
  egress: "`npm run verify:xometry-egress` output attached at https://github.com/optomachina/Overdrafter/pull/1",
  "admission-revision": "https://linear.app/overdrafter/issue/OVD-404 revision fictiv-admit.v1",
  rollout: "https://linear.app/overdrafter/issue/OVD-405",
  certification: "https://example.test/cert/123",
  rollback: "docs/workflows/ovd673-fictiv-live-readiness.md",
};

/**
 * Build a Provider go-live section from the validator's own labels. `overrides`
 * maps item id to the full line (after `- `) or to null to drop the item.
 */
function buildProviderGoLiveSection({ overrides = {}, heading = `## ${PROVIDER_GO_LIVE_HEADING}` } = {}) {
  const lines = PROVIDER_GO_LIVE_REQUIRED_ITEMS.flatMap((item) => {
    if (item.id in overrides) {
      return overrides[item.id] === null ? [] : [`- ${overrides[item.id]}`];
    }
    return [`- [x] ${item.label}. Evidence: ${EVIDENCE[item.id]}`];
  });

  return `

${heading}

${lines.join("\n")}
`;
}

function labelOf(id) {
  return PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((item) => item.id === id).label;
}

function validateProvider(section, changedFiles = ENVELOPE_FILES) {
  return validatePrBody(buildValidPrBody() + section, { changedFiles });
}

describe("validatePrBody", () => {
  it("accepts a complete PR body", () => {
    expect(validatePrBody(buildValidPrBody())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects a missing required section", () => {
    const body = buildValidPrBody().replace("## Problem", "## Context");
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing required section "Problem"');
  });

  it("rejects template placeholder text", () => {
    const body = buildValidPrBody().replace(
      "Adds a pull-request body validator and documents the handoff expectation.",
      "Describe the change briefly.",
    );
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('replace template placeholder text in "Summary"');
  });

  it("rejects intentionally empty sections", () => {
    const body = buildValidPrBody().replace(
      /## Rollback \/ risk notes[\s\S]*?## Documentation/,
      `## Rollback / risk notes

## Documentation`,
    );
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('add non-empty content to "Rollback / risk notes"');
  });

  it("rejects unchecked migration and documentation boilerplate without details", () => {
    const body = buildValidPrBody()
      .replace("- [x] No migration impact", "- [ ] No migration impact")
      .replace("- [x] Docs updated", "- [ ] Docs updated")
      .replace("Updated contributor workflow docs and Codex skill instructions.", "");
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('mark or explain "Migration notes" instead of leaving it blank');
    expect(result.errors).toContain('mark or explain "Documentation" instead of leaving it blank');
  });

  it("does not require Provider go-live when no provider go-live path changed", () => {
    const body = buildValidPrBody();

    expect(validatePrBody(body)).toEqual({ ok: true, errors: [] });
    expect(
      validatePrBody(body, { changedFiles: ["docs/provider-integration.md", "scripts/validate-pr-body.mjs"] }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("keeps requiring a real Verification command on non-provider PRs", () => {
    const body = buildValidPrBody().replace(/```bash[\s\S]*?```/, "");
    expect(validatePrBody(body).errors).toContain('add at least one real command to "Verification"');
  });

  it("rejects a provider PR without the Provider go-live section", () => {
    const result = validatePrBody(buildValidPrBody(), { changedFiles: ENVELOPE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches provider go-live paths (${ENVELOPE_FILES[0]})`,
    );
  });

  it("accepts a full valid provider body", () => {
    expect(validateProvider(buildProviderGoLiveSection())).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["worker/src/providerDispatchEnvelope.ts"],
    ["supabase/migrations/20261011200000_ovd675_weerg_reviewed_dispatch_envelope.sql"],
  ])("requires Provider go-live when only %s changed", (file) => {
    const result = validatePrBody(buildValidPrBody(), { changedFiles: [file] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/missing required section "Provider go-live"/);
    expect(validateProvider(buildProviderGoLiveSection(), [file])).toEqual({ ok: true, errors: [] });
  });

  it("rejects unticked boxes even when they say N/A", () => {
    const result = validateProvider(
      buildProviderGoLiveSection({
        overrides: {
          certification: `[ ] ${labelOf("certification")}. Evidence: N/A: fixture-only change, no hosted run yet`,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([`tick [x] for Provider go-live item "${labelOf("certification")}"`]);
  });

  it("rejects N/A on admission items", () => {
    for (const id of ["provider-check", "envelope-reviewer", "admission-revision"]) {
      const result = validateProvider(
        buildProviderGoLiveSection({
          overrides: { [id]: `[x] ${labelOf(id)}. Evidence: N/A: this pull request does not admit a provider` },
        }),
      );
      expect(result.errors).toEqual([`"${labelOf(id)}" is an admission item and cannot be N/A`]);
    }
  });

  it.each(["N/A: x", "n/a", "N/A -", "N/A: tbd", "N/A: none", "N/A: ...", "N/A: not needed"])(
    "rejects placeholder N/A reason %j",
    (attestation) => {
      const result = validateProvider(
        buildProviderGoLiveSection({
          overrides: { egress: `[x] ${labelOf("egress")}. Evidence: ${attestation}` },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([
        `give a real N/A reason (at least 15 characters and 3 words) for "${labelOf("egress")}"`,
      ]);
    },
  );

  it("accepts a ticked N/A with a real reason on a non-admission item", () => {
    const result = validateProvider(
      buildProviderGoLiveSection({
        overrides: {
          egress: `[x] ${labelOf("egress")} N/A: fixture-only change, worker egress is unchanged`,
          certification: `[x] ${labelOf("certification")}. Evidence: N/A: hosted certification runs after the admit PR`,
        },
      }),
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["bare tick", (label) => `[x] ${label}`],
    ["empty evidence", (label) => `[x] ${label}. Evidence:`],
    ["prose evidence", (label) => `[x] ${label}. Evidence: bob said it was fine`],
    ["URL without host", (label) => `[x] ${label}. Evidence: http://x`],
  ])("rejects %s", (_name, build) => {
    const result = validateProvider(
      buildProviderGoLiveSection({ overrides: { rollout: build(labelOf("rollout")) } }),
    );
    expect(result.errors).toEqual([
      `add evidence (URL, \`command\`, commit SHA, or repo file path) for "${labelOf("rollout")}"`,
    ]);
  });

  it.each(["TBD", "TODO https://example.test/later", "<link>", "...", "`npm run provider:check` <sha>"])(
    "rejects placeholder evidence %j",
    (evidence) => {
      const result = validateProvider(
        buildProviderGoLiveSection({
          overrides: { rollback: `[x] ${labelOf("rollback")}. Evidence: ${evidence}` },
        }),
      );
      expect(result.errors).toEqual([`replace placeholder evidence for "${labelOf("rollback")}"`]);
    },
  );

  it("does not count backticks inside the label as evidence", () => {
    const result = validateProvider(
      buildProviderGoLiveSection({
        overrides: {
          "admission-revision": `[x] ${labelOf("admission-revision")}. Admit SQL was not added to \`supabase/migrations/\`. Evidence:`,
        },
      }),
    );
    expect(result.errors).toEqual([
      `add evidence (URL, \`command\`, commit SHA, or repo file path) for "${labelOf("admission-revision")}"`,
    ]);
  });

  it("fails a single keyword-stuffed line for all-but-at-most-one item", () => {
    const stuffed =
      "- [x] provider:check green named reviewer generic_dispatch_enabled=true automatic_quote_collection Secret Manager egress certification rollback https://example.test/all";
    const result = validateProvider(`\n\n## ${PROVIDER_GO_LIVE_HEADING}\n\n${stuffed}\n`);
    const missing = result.errors.filter((error) => error.startsWith("missing Provider go-live item"));

    expect(result.ok).toBe(false);
    expect(missing.length).toBeGreaterThanOrEqual(PROVIDER_GO_LIVE_REQUIRED_ITEMS.length - 1);
  });

  it("rejects two checkbox lines for the same item", () => {
    const section = buildProviderGoLiveSection() + `- [x] ${labelOf("rollback")}. Evidence: https://example.test/again\n`;
    expect(validateProvider(section).errors).toEqual([
      `use exactly one checkbox line for Provider go-live item "${labelOf("rollback")}"`,
    ]);
  });

  it("does not match a label as a prefix of a longer word", () => {
    const result = validateProvider(
      buildProviderGoLiveSection({
        overrides: { "provider-check": "[x] provider:check greenish. Evidence: `npm run provider:check`" },
      }),
    );
    expect(result.errors[0]).toMatch(/^missing Provider go-live item "provider:check green"/);
  });

  it.each(["```", "~~~"])("ignores a Provider go-live heading and checkboxes inside a %s fence", (fence) => {
    const fenced = `\n\n${fence}md\n## ${PROVIDER_GO_LIVE_HEADING}\n${buildProviderGoLiveSection()}\n${fence}\n`;
    const result = validateProvider(fenced);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches provider go-live paths (${ENVELOPE_FILES[0]})`,
    );
  });

  it("ignores fenced checkboxes inside the real section", () => {
    const fencedExample = `\n\`\`\`md\n- [x] ${labelOf("rollback")}. Evidence: https://example.test/fake\n\`\`\`\n`;
    const section = buildProviderGoLiveSection({ overrides: { rollback: null } }) + fencedExample;
    expect(validateProvider(section).errors[0]).toMatch(/^missing Provider go-live item "Rollback\/disable/);
  });

  it("accepts a ### Provider go-live heading and a case-insensitive title", () => {
    expect(validateProvider(buildProviderGoLiveSection({ heading: `### ${PROVIDER_GO_LIVE_HEADING}` }))).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateProvider(buildProviderGoLiveSection({ heading: "## PROVIDER GO-LIVE" }))).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("includes ### subsections in a ## section but ends a ### section at the next ###", () => {
    const items = buildProviderGoLiveSection().trim().split("\n").slice(2);
    const split = `\n\n## ${PROVIDER_GO_LIVE_HEADING}\n\n### Envelope\n\n${items.slice(0, 4).join("\n")}\n\n### Admit\n\n${items.slice(4).join("\n")}\n`;
    expect(validateProvider(split)).toEqual({ ok: true, errors: [] });

    const level3 = split.replace(`## ${PROVIDER_GO_LIVE_HEADING}`, `### ${PROVIDER_GO_LIVE_HEADING}`);
    const result = validateProvider(level3);
    expect(result.errors).toContain(`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`);
  });

  it("does not leak a ## section past the next ## heading", () => {
    const section = buildProviderGoLiveSection({ overrides: { rollback: null } });
    const trailing = `\n## Follow-up items\n\n- [x] ${labelOf("rollback")}. Evidence: https://example.test/rb\n`;
    expect(validateProvider(section + trailing).errors[0]).toMatch(/^missing Provider go-live item "Rollback/);
  });
});

describe("provider go-live paths", () => {
  it("matches every protected path family", () => {
    for (const file of [
      "test-fixtures/provider-dispatch-envelope/v1.json",
      "test-fixtures/provider-dispatch-envelope/nested/sendcutsend-v1.json",
      "worker/src/providerDispatchEnvelope.ts",
      "supabase/migrations/20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql",
      "provider-integrations/provider-registry.v1.json",
      "provider-integrations/provider-registry.schema.json",
      "worker/src/generated/providerRegistry.ts",
      "scripts/provider-registry.mjs",
      "scripts/provider-sync.mjs",
      "scripts/provider-check.mjs",
      "worker/scripts/generated/provider-secrets.sh",
      "worker\\src\\providerDispatchEnvelope.ts",
      "./provider-integrations/x.json",
    ]) {
      expect(matchesProviderGoLivePath(file), file).toBe(true);
    }
  });

  it("does not match near-miss paths", () => {
    for (const file of [
      "my-provider-dispatch-envelope/a",
      "provider-dispatch-envelope/a",
      "src/provider-dispatch-envelope/a",
      "docs/provider-dispatch-envelope/readme.md",
      "test-fixtures/provider-dispatch-envelopes/a.json",
      "test-fixtures/provider-dispatch-envelope",
      "worker/src/providerDispatchEnvelope.test.ts",
      "worker/src/providerDispatchEnvelope.tsx",
      "supabase/migrations/nested/x_reviewed_dispatch_envelope.sql",
      "supabase/migrations/20261011_reviewed_dispatch_envelope.sql.bak",
      "supabase/tests/x_reviewed_dispatch_envelope.sql",
      "docs/provider-integrations/x.md",
      "scripts/provider-check.test.mjs",
      "Worker/src/providerDispatchEnvelope.ts",
    ]) {
      expect(matchesProviderGoLivePath(file), file).toBe(false);
    }
    expect(touchesProviderGoLivePath(["my-provider-dispatch-envelope/a"])).toBe(false);
    expect(validatePrBody(buildValidPrBody(), { changedFiles: ["my-provider-dispatch-envelope/a"] })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("exports root-anchored glob patterns", () => {
    expect(PROVIDER_GO_LIVE_PATH_PATTERNS).toContain("test-fixtures/provider-dispatch-envelope/**");
    expect(PROVIDER_GO_LIVE_PATH_PATTERNS).toContain("supabase/migrations/*_reviewed_dispatch_envelope.sql");
  });

  it("parses rename source and destination from name-status output", () => {
    const output = [
      "R100\ttest-fixtures/provider-dispatch-envelope/fictiv-v1.json\tarchive/fictiv-v1.json",
      "M\tdocs/provider-integration.md",
      "",
    ].join("\n");
    const files = parseChangedFiles(output);

    expect(files).toEqual([
      "test-fixtures/provider-dispatch-envelope/fictiv-v1.json",
      "archive/fictiv-v1.json",
      "docs/provider-integration.md",
    ]);
    expect(touchesProviderGoLivePath(files)).toBe(true);
  });

  it("parses --no-renames delete lines and plain --name-only output", () => {
    expect(parseChangedFiles("D\tworker/src/providerDispatchEnvelope.ts\nA\tworker/src/moved.ts\n")).toEqual([
      "worker/src/providerDispatchEnvelope.ts",
      "worker/src/moved.ts",
    ]);
    expect(parseChangedFiles("docs/a.md\r\nscripts/provider-sync.mjs\n")).toEqual([
      "docs/a.md",
      "scripts/provider-sync.mjs",
    ]);
  });
});

describe("validate-pr-body CLI", () => {
  async function runCli(body, changedFilesText) {
    const dir = mkdtempSync(path.join(tmpdir(), "pr-body-"));
    const bodyPath = path.join(dir, "body.md");
    const changedPath = path.join(dir, "changed.txt");
    writeFileSync(bodyPath, body);
    writeFileSync(changedPath, changedFilesText);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return await main([bodyPath, "--changed-files-from", changedPath]);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  }

  it("fails when a file is renamed out of a protected path without the section", async () => {
    const renamed = "R095\ttest-fixtures/provider-dispatch-envelope/v1.json\tlegacy/v1.json\n";
    expect(await runCli(buildValidPrBody(), renamed)).toBe(1);
    expect(await runCli(buildValidPrBody() + buildProviderGoLiveSection(), renamed)).toBe(0);
  });

  it("passes a non-provider PR", async () => {
    expect(await runCli(buildValidPrBody(), "M\tdocs/provider-integration.md\n")).toBe(0);
  });
});

describe("provider go-live docs", () => {
  it("links the checklist from every provider-integration stage and the OVD-687 runbook block", () => {
    const doc = readFileSync(path.join("docs", "provider-integration.md"), "utf8");
    const checklistHref = "checklists/provider-go-live-checklist.md";
    const headingMatches = [...doc.matchAll(/^### .+$/gm)];
    const requiredPrefixes = [
      "### 1. Define",
      "### 2. Make",
      "### 3. Admit",
      "### Generated-stage runbook (OVD-687)",
    ];

    for (const prefix of requiredPrefixes) {
      const headingIndex = headingMatches.findIndex((match) => match[0].startsWith(prefix));
      expect(headingIndex >= 0, `missing heading ${prefix}`).toBe(true);
      const heading = headingMatches[headingIndex];
      const start = heading.index + heading[0].length;
      const end =
        headingIndex + 1 < headingMatches.length ? headingMatches[headingIndex + 1].index : doc.length;
      expect(doc.slice(start, end)).toContain(checklistHref);
    }
  });

  it("keeps the PR template Provider go-live items aligned with the validator", () => {
    const template = readFileSync(path.join(".github", "pull_request_template.md"), "utf8");
    expect(template).toContain(`## ${PROVIDER_GO_LIVE_HEADING}`);

    const start = template.indexOf(`## ${PROVIDER_GO_LIVE_HEADING}`);
    const end = template.indexOf("\n## ", start + 1);
    const section = template.slice(start, end);
    const boxes = section
      .replace(/<!--[\s\S]*?-->/g, "")
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "));

    expect(boxes).toHaveLength(PROVIDER_GO_LIVE_REQUIRED_ITEMS.length);
    for (const item of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
      expect(
        boxes.filter((line) => line.slice(6).startsWith(item.label)),
        item.label,
      ).toHaveLength(1);
    }

    // Filling the template's own lines (tick + evidence) must satisfy the gate.
    const filled = boxes
      .map((line) => {
        const item = PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((candidate) => line.slice(6).startsWith(candidate.label));
        return `${line.replace("- [ ] ", "- [x] ")} ${EVIDENCE[item.id]}`;
      })
      .join("\n");
    expect(validateProvider(`\n\n## ${PROVIDER_GO_LIVE_HEADING}\n\n${filled}\n`)).toEqual({ ok: true, errors: [] });

    // The unfilled template section must fail on every item.
    expect(validateProvider(`\n\n${section}`).errors).toHaveLength(PROVIDER_GO_LIVE_REQUIRED_ITEMS.length * 2);
  });

  it("re-runs on PR body edits and diffs with name-status", () => {
    const workflow = readFileSync(path.join(".github", "workflows", "ci.yml"), "utf8");
    const types = workflow.match(/pull_request:\n\s+types:\n((?:\s+(?:- \S+|#.*)\n)+)/)[1];
    for (const type of ["opened", "synchronize", "reopened", "ready_for_review", "edited"]) {
      expect(types).toContain(`- ${type}`);
    }
    expect(workflow).toMatch(/git diff --name-status --no-renames "\$\{BASE_SHA\}\.\.\.HEAD"/);
  });

  it("does not path-filter the provider go-live CI job so non-provider PRs stay green", () => {
    const workflow = readFileSync(path.join(".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toMatch(/validate-provider-go-live:/);
    expect(workflow).toMatch(/- validate-provider-go-live/);
    expect(workflow).not.toMatch(/validate-provider-go-live:[\s\S]*?paths:/);
  });
});
