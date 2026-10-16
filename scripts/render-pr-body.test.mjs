// @vitest-environment node

import { describe, expect, it } from "vitest";

import { renderPrBody } from "./render-pr-body.mjs";
import { PROVIDER_GO_LIVE_REQUIRED_ITEMS, validatePrBody } from "./validate-pr-body.mjs";

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

  it("accepts an explicit empty baseline-failures list", () => {
    const rendered = renderPrBody({
      ...buildInput(),
      verification: {
        ...buildInput().verification,
        baselineFailures: [],
      },
    });

    expect(rendered).toContain("Baseline failures or exceptions:");
    expect(rendered).toContain("None.");
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

  describe("providerGoLive", () => {
    const evidence = "https://github.com/optomachina/Overdrafter/pull/690";
    const full = () =>
      Object.fromEntries(
        PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => !item.auto).map((item) => [
          item.id,
          item.na && item.id === "egress"
            ? { na: "this stage does not change egress" }
            : { evidence },
        ]),
      );

    it("omits the section unless requested", () => {
      expect(renderPrBody(buildInput())).not.toContain("Provider go-live");
    });

    it("emits the Provider go-live section with evidence and N/A items", () => {
      const rendered = renderPrBody({ ...buildInput(), providerGoLive: full() });
      expect(rendered).toContain("## Provider go-live");
      expect(rendered).toContain("### Legal stance");
      expect(rendered).toContain(`- [x] provider:check green. Evidence: ${evidence}`);
      expect(rendered).toContain("N/A: this stage does not change egress");
      expect(rendered).toContain(`- [x] Per-supplier on/off switch in the admin dashboard`);
    });

    it("fills the envelope review item automatically, pre-checked and signed", () => {
      const rendered = renderPrBody({ ...buildInput(), providerGoLive: full() });
      expect(rendered).toContain(
        "- [x] Envelope reviewed (automatic). Signed: Grok Bot under Blaine Wilson standing authority.",
      );
      expect(() =>
        renderPrBody({ ...buildInput(), providerGoLive: { ...full(), "envelope-reviewer": { evidence } } }),
      ).toThrow("providerGoLive.envelope-reviewer is filled automatically");
    });

    it("rejects an unknown item, a missing item, and N/A on a legal stance item", () => {
      expect(() => renderPrBody({ ...buildInput(), providerGoLive: { bogus: { evidence } } })).toThrow(
        "providerGoLive.bogus is not a checklist item",
      );
      const { "supplier-switch": _omitted, ...partial } = full();
      expect(() => renderPrBody({ ...buildInput(), providerGoLive: partial })).toThrow(
        "providerGoLive.supplier-switch must be an object",
      );
      expect(() =>
        renderPrBody({ ...buildInput(), providerGoLive: { ...full(), "supplier-switch": { na: "does not apply here" } } }),
      ).toThrow("N/A is not allowed");
    });

    it("rejects a non evidence URL", () => {
      expect(() =>
        renderPrBody({ ...buildInput(), providerGoLive: { ...full(), "provider-check": { evidence: "https://example.test/x" } } }),
      ).toThrow("add an evidence link");
    });
  });
});
