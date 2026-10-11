// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE,
  PROVIDER_GO_LIVE_HEADING,
  PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX,
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  touchesProviderGoLivePaths,
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

const GO_LIVE_FILES = [PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE];
const REVIEWED_MIGRATION_FILE =
  "supabase/migrations/20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql";
const INTEGRATIONS_FILE = `${PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX}provider-registry.v1.json`;

const CHECKED_GO_LIVE_ITEMS = [
  {
    id: "provider-check",
    admission: false,
    text: "provider:check green. Evidence: `npm run provider:check` on abcdef1",
  },
  {
    id: "envelope-reviewer",
    admission: false,
    text: "Envelope reviewed by a named reviewer. Evidence: https://linear.app/overdrafter/issue/OVD-404",
  },
  {
    id: "admission-revision",
    admission: true,
    text: "Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Evidence: https://linear.app/overdrafter/issue/OVD-404",
  },
  {
    id: "rollout",
    admission: true,
    text: "`automatic_quote_collection` rollout and org enablement. Evidence: https://linear.app/overdrafter/issue/OVD-404",
  },
  {
    id: "worker-secret",
    admission: false,
    text: "Worker adapter deployed and Secret Manager secret created (name only). Evidence: worker/scripts/generated/provider-secrets.sh",
  },
  {
    id: "egress",
    admission: false,
    text: "Stable egress verified (`verify:xometry-egress`-style). Evidence: https://example.test/egress",
  },
  {
    id: "certification",
    admission: true,
    text: "Certification run evidence: https://example.test/cert",
  },
  {
    id: "rollback",
    admission: true,
    text: "Rollback/disable steps rehearsed. Evidence: https://example.test/rollback",
  },
];

function formatGoLiveItem(item, mode) {
  if (mode === "unchecked") {
    return `- [ ] ${item.text}`;
  }

  if (mode === "na") {
    const naSuffix = item.admission
      ? item.text
      : `${item.text} N/A: this PR only updates the reviewed envelope registry`;
    return `- [x] ${naSuffix}`;
  }

  return `- [x] ${item.text}`;
}

function buildProviderGoLiveSection({ mode = "checked", items = CHECKED_GO_LIVE_ITEMS } = {}) {
  const byId = Object.fromEntries(CHECKED_GO_LIVE_ITEMS.map((item) => [item.id, item]));
  const resolved = items.map((item) => ({ ...byId[item.id], ...item }));
  const envelope = resolved.filter((item) => item.id === "provider-check" || item.id === "envelope-reviewer");
  const live = resolved.filter((item) => item.id === "worker-secret" || item.id === "egress");
  const admit = resolved.filter(
    (item) =>
      item.id === "admission-revision" ||
      item.id === "rollout" ||
      item.id === "certification" ||
      item.id === "rollback",
  );

  return `

## ${PROVIDER_GO_LIVE_HEADING}

### Envelope

${envelope.map((item) => formatGoLiveItem(item, mode)).join("\n")}

### Live

${live.map((item) => formatGoLiveItem(item, mode)).join("\n")}

### Admit

${admit.map((item) => formatGoLiveItem(item, mode)).join("\n")}
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

  it("does not require Provider go-live when no go-live path changed", () => {
    const body = buildValidPrBody();

    expect(validatePrBody(body)).toEqual({ ok: true, errors: [] });
    expect(
      validatePrBody(body, { changedFiles: ["docs/provider-integration.md", "scripts/validate-pr-body.mjs"] }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("rejects a PR that touches a go-live path without the Provider go-live section", () => {
    const result = validatePrBody(buildValidPrBody(), { changedFiles: GO_LIVE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`,
    );
  });

  it("rejects unchecked Provider go-live boxes on a go-live PR", () => {
    const result = validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "unchecked" }), {
      changedFiles: GO_LIVE_FILES,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('check "provider:check green"');
    expect(result.errors).toContain(
      'check "approved admission revision (generic_dispatch_enabled=true)"',
    );
  });

  it("accepts a go-live PR when every Provider go-live box is checked with evidence", () => {
    expect(
      validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "checked" }), {
        changedFiles: GO_LIVE_FILES,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("accepts N/A with a real justification on non-admission items", () => {
    expect(
      validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ mode: "na" }), {
        changedFiles: GO_LIVE_FILES,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("requires the section when only providerDispatchEnvelope.ts changed", () => {
    const result = validatePrBody(buildValidPrBody(), {
      changedFiles: [PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`,
    );
  });

  it("requires the section when only a reviewed-envelope migration changed", () => {
    const result = validatePrBody(buildValidPrBody(), {
      changedFiles: [REVIEWED_MIGRATION_FILE],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`,
    );
  });

  it("rejects N/A without a tick", () => {
    const items = CHECKED_GO_LIVE_ITEMS.map((item) =>
      item.id === "egress"
        ? {
            ...item,
            text: `${item.text} N/A: this PR only updates the reviewed envelope registry`,
          }
        : item,
    );
    const body =
      buildValidPrBody() +
      buildProviderGoLiveSection({ items }).replace(
        "- [x] Stable egress verified",
        "- [ ] Stable egress verified",
      );
    const result = validatePrBody(body, { changedFiles: GO_LIVE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('check N/A item "stable egress verified"');
  });

  it("rejects N/A on an admission item", () => {
    const items = CHECKED_GO_LIVE_ITEMS.map((item) =>
      item.id === "admission-revision"
        ? {
            ...item,
            text: `${item.text} N/A: this PR only updates the reviewed envelope registry`,
          }
        : item,
    );
    const result = validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ items }), {
      changedFiles: GO_LIVE_FILES,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'N/A is not allowed for admission item "approved admission revision (generic_dispatch_enabled=true)"',
    );
  });

  it.each(["N/A: x", "n/a", "N/A: -", "N/A: tbd"])("rejects a placeholder %s", (placeholder) => {
    const items = CHECKED_GO_LIVE_ITEMS.map((item) =>
      item.id === "egress" ? { ...item, text: `${item.text} ${placeholder}` } : item,
    );
    const result = validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ items }), {
      changedFiles: GO_LIVE_FILES,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('mark N/A with a real justification for "stable egress verified"');
  });

  it("rejects empty evidence", () => {
    const items = CHECKED_GO_LIVE_ITEMS.map((item) =>
      item.id === "envelope-reviewer"
        ? { ...item, text: "Envelope reviewed by a named reviewer. Evidence:" }
        : item,
    );
    const result = validatePrBody(buildValidPrBody() + buildProviderGoLiveSection({ items }), {
      changedFiles: GO_LIVE_FILES,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'add evidence (link, command, SHA, or path) for "envelope reviewed by a named reviewer"',
    );
  });

  it("rejects a keyword-stuffed single line that tries to satisfy every item", () => {
    const stuffed = `
## ${PROVIDER_GO_LIVE_HEADING}

- [x] provider:check green Envelope reviewed by a named reviewer Approved admission revision automatic_quote_collection Secret Manager secret Stable egress verified Certification run evidence Rollback/disable steps rehearsed Evidence: https://example.test/all
`;
    const result = validatePrBody(buildValidPrBody() + stuffed, { changedFiles: GO_LIVE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors.filter((error) => error.startsWith("missing Provider go-live item "))).toHaveLength(7);
  });

  it("ignores a Provider go-live heading inside a code fence", () => {
    const fenced = `
\`\`\`
## ${PROVIDER_GO_LIVE_HEADING}

- [x] provider:check green Envelope reviewed by a named reviewer Approved admission revision automatic_quote_collection Secret Manager secret Stable egress verified Certification run evidence Rollback/disable steps rehearsed Evidence: https://example.test/all
\`\`\`
`;
    const result = validatePrBody(buildValidPrBody() + fenced, { changedFiles: GO_LIVE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`,
    );
  });

  it("does not treat a ### Provider go-live heading as the required section", () => {
    const body = `${buildValidPrBody()}

### ${PROVIDER_GO_LIVE_HEADING}

${CHECKED_GO_LIVE_ITEMS.map((item) => `- [x] ${item.text}`).join("\n")}
`;
    const result = validatePrBody(body, { changedFiles: GO_LIVE_FILES });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that touches a provider go-live path`,
    );
  });
});

describe("touchesProviderGoLivePaths", () => {
  it("matches real go-live paths by prefix or glob, not substring", () => {
    expect(touchesProviderGoLivePaths([PROVIDER_GO_LIVE_DISPATCH_ENVELOPE_FILE])).toBe(true);
    expect(touchesProviderGoLivePaths([REVIEWED_MIGRATION_FILE])).toBe(true);
    expect(touchesProviderGoLivePaths([INTEGRATIONS_FILE])).toBe(true);
    expect(touchesProviderGoLivePaths(["test-fixtures/provider-dispatch-envelope/v1.json"])).toBe(false);
    expect(touchesProviderGoLivePaths(["worker/src/providerDispatchEnvelope.test.ts"])).toBe(false);
    expect(touchesProviderGoLivePaths(["docs/notes/provider-integrations-overview.md"])).toBe(false);
    expect(
      touchesProviderGoLivePaths(["docs/supabase/migrations/copy_reviewed_dispatch_envelope.sql"]),
    ).toBe(false);
  });

  it("includes a rename source out of a protected path", () => {
    expect(
      touchesProviderGoLivePaths([
        `R100\t${PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX}sendcutsend/manifest.v1.json\tdocs/moved-manifest.json`,
      ]),
    ).toBe(true);
    expect(touchesProviderGoLivePaths(["docs/moved-manifest.json"])).toBe(false);
    expect(
      touchesProviderGoLivePaths([
        `D\t${PROVIDER_GO_LIVE_INTEGRATIONS_PREFIX}sendcutsend/manifest.v1.json`,
        "A\tdocs/moved-manifest.json",
      ]),
    ).toBe(true);
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
    expect(workflow).toMatch(/^\s+- edited$/m);
    expect(workflow).toMatch(/git diff --name-status --no-renames/);
    expect(workflow).toMatch(/--skip-unless-go-live/);
  });
});
