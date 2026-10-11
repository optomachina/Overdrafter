// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVIDER_DISPATCH_ENVELOPE_DIR,
  PROVIDER_GO_LIVE_HEADING,
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  touchesProviderDispatchEnvelope,
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

const ENVELOPE_FILES = [`test-fixtures/${PROVIDER_DISPATCH_ENVELOPE_DIR}v1.json`];

function buildProviderGoLiveSection({ mode = "checked" } = {}) {
  const items = [
    "provider:check green",
    "Envelope reviewed by a named reviewer. Evidence: https://linear.app/overdrafter/issue/OVD-404",
    "Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Evidence: https://linear.app/overdrafter/issue/OVD-404",
    "`automatic_quote_collection` rollout and org enablement. Evidence: https://linear.app/overdrafter/issue/OVD-404",
    "Worker adapter deployed and Secret Manager secret created (name only). Evidence: QUICKPARTS_STORAGE_STATE_SECRET_NAME",
    "Stable egress verified (`verify:xometry-egress`-style). Evidence: https://example.test/egress",
    "Certification run evidence: https://example.test/cert",
    "Rollback/disable steps rehearsed. Evidence: https://example.test/rollback",
  ];

  const lines = items.map((item) => {
    if (mode === "unchecked") {
      return `- [ ] ${item}`;
    }

    if (mode === "na") {
      return `- [x] ${item} N/A: fixture-only, this PR does not admit a provider`;
    }

    return `- [x] ${item}`;
  });

  return `

## ${PROVIDER_GO_LIVE_HEADING}

${lines.join("\n")}
`;
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

  it("does not require Provider go-live when the envelope directory is untouched", () => {
    const body = buildValidPrBody();

    expect(validatePrBody(body)).toEqual({ ok: true, errors: [] });
    expect(
      validatePrBody(body, { changedFiles: ["docs/provider-integration.md", "scripts/validate-pr-body.mjs"] }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("rejects a PR that touches the envelope directory without the Provider go-live section", () => {
    const result = validatePrBody(buildValidPrBody(), { changedFiles: ENVELOPE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches provider-dispatch-envelope/`,
    );
  });

  it("rejects unchecked Provider go-live boxes on an envelope PR", () => {
    const result = validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "unchecked" }), {
      changedFiles: ENVELOPE_FILES,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('check or mark N/A with a reason for "provider:check green"');
    expect(result.errors).toContain(
      'check or mark N/A with a reason for "approved admission revision (generic_dispatch_enabled=true)"',
    );
  });

  it("accepts an envelope PR when every Provider go-live box is checked with evidence", () => {
    expect(
      validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "checked" }), {
        changedFiles: ENVELOPE_FILES,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("accepts N/A with a reason on non-admitting envelope PRs", () => {
    expect(
      validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "na" }), {
        changedFiles: ENVELOPE_FILES,
      }),
    ).toEqual({ ok: true, errors: [] });
  });
});

describe("touchesProviderDispatchEnvelope", () => {
  it("matches only provider-dispatch-envelope directories", () => {
    expect(touchesProviderDispatchEnvelope(["worker/src/providerDispatchEnvelope.ts"])).toBe(false);
    expect(touchesProviderDispatchEnvelope(ENVELOPE_FILES)).toBe(true);
    expect(touchesProviderDispatchEnvelope([`${PROVIDER_DISPATCH_ENVELOPE_DIR}sendcutsend-v1.json`])).toBe(true);
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
    for (const item of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
      expect(item.match.test(template), item.label).toBe(true);
    }
  });

  it("does not path-filter the provider go-live CI job so non-provider PRs stay green", () => {
    const workflow = readFileSync(path.join(".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toMatch(/validate-provider-go-live:/);
    expect(workflow).toMatch(/- validate-provider-go-live/);
    expect(workflow).not.toMatch(/validate-provider-go-live:[\s\S]*?paths:/);
  });
});
