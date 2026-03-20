import { describe, expect, it } from "vitest";

import { renderPrBody } from "./render-pr-body.mjs";
import { validatePrBody } from "./validate-pr-body.mjs";

function buildInput() {
  return {
    summary: [
      "Adds a deterministic PR-body renderer for Codex workflows.",
      "Keeps the validator strict while making compliant PR creation repeatable.",
    ],
    problem: [
      "Codex instructions told agents to fill the template, but did not give them one durable command path.",
    ],
    scope: [
      "Adds a JSON-driven renderer that emits the repo template headings.",
      "Updates workflow docs and skills to create or edit PRs with --body-file.",
      "Does not change app runtime behavior.",
    ],
    verification: {
      allPassed: true,
      usedVerify: false,
      usedNarrowVerification: true,
      hasOtherVerification: true,
      commands: [
        "npm run test -- scripts/validate-pr-body.test.mjs scripts/render-pr-body.test.mjs",
        "./scripts/symphony-preflight.sh",
      ],
      results: [
        "All listed verification passed.",
        "Narrower verification was sufficient because this change only affects workflow docs, CI config, and repo scripts.",
      ],
    },
    tests: [
      "Added renderer coverage for valid output, no-migration and no-doc-update variants, and missing required fields.",
    ],
    migrationNotes: {
      hasImpact: false,
    },
    rollbackRisks: [
      "If the renderer input shape drifts from repo expectations, PR creation could fail before publishing.",
      "Rollback by reverting the helper and restoring manual PR-body editing instructions.",
    ],
    documentation: {
      updated: true,
      details: [
        "Updated CI, recurring workflow docs, contributor guidance, and repo-local PR skills to use the renderer.",
      ],
    },
  };
}

describe("renderPrBody", () => {
  it("renders a complete PR body that passes validation", () => {
    const rendered = renderPrBody(buildInput());

    expect(validatePrBody(rendered)).toEqual({
      ok: true,
      errors: [],
    });
    expect(rendered).toContain("## Summary");
    expect(rendered).toContain("## Documentation");
  });

  it("renders no-impact migration and no-doc-update states", () => {
    const rendered = renderPrBody({
      ...buildInput(),
      migrationNotes: {
        hasImpact: false,
        details: ["No schema or migration files changed."],
      },
      documentation: {
        updated: false,
        details: ["No doc updates were needed because the change only refreshed existing generated PR content."],
      },
    });

    expect(rendered).toContain("- [x] No migration impact");
    expect(rendered).toContain("- [x] No doc updates needed");
    expect(validatePrBody(rendered).ok).toBe(true);
  });

  it("supports multiple commands and explicit narrow-verification justification", () => {
    const rendered = renderPrBody({
      ...buildInput(),
      verification: {
        allPassed: true,
        usedVerify: false,
        usedNarrowVerification: true,
        hasOtherVerification: true,
        commands: [
          "npm run test -- scripts/render-pr-body.test.mjs",
          "npm run test -- scripts/validate-pr-body.test.mjs",
          "./scripts/symphony-preflight.sh",
        ],
        results: [
          "All listed verification passed.",
          "Narrower verification was intentionally sufficient because no application runtime code changed.",
          "Other relevant verification included direct review of the pull_request edited trigger.",
        ],
      },
    });

    expect(rendered).toContain("npm run test -- scripts/render-pr-body.test.mjs");
    expect(rendered).toContain("Narrower verification was intentionally sufficient");
    expect(validatePrBody(rendered).ok).toBe(true);
  });

  it("rejects missing required fields before rendering", () => {
    expect(() =>
      renderPrBody({
        ...buildInput(),
        summary: [],
      }),
    ).toThrow("summary must be a non-empty string or array");
  });
});
