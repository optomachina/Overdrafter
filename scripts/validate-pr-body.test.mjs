import { describe, expect, it } from "vitest";

import { validatePrBody } from "./validate-pr-body.mjs";

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
});
