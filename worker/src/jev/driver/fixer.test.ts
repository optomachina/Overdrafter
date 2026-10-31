// @vitest-environment node
import { describe, expect, it } from "vitest";
import { XOMETRY_DRIVER_VOCABULARY, xometryDrivenRepairCandidate } from "../../adapters/xometryDriver";
import { acceptLocatorCandidate, drivenRepairTaskPayload, parseDrivenLocatorCandidate, SKELETON_HEADER } from "./fixer";
import type { DriverOutcome, DriverRunSummary } from "./types";

const summary = {
  schema: "jev-driver-run.v1", revision: "jev-quote-driver.v1", policyRevision: "p", snapshotRevision: "s", vocabularyDigest: "0123456789abcdef",
  outcome: "completed", stopReason: null, subGoals: { quantity: "verified" }, cycles: 3, modelCalls: 1, codeDecisions: 2, actions: 2,
  inputTokens: 1200, outputTokens: 0, tokensEstimated: false, costUsdEstimate: 0.00005, priceSource: "x", cycleLatencyMs: { p50: 1, p95: 2 },
  elapsedMs: 10, gateHits: {},
} satisfies DriverRunSummary;

describe("fixer: driven_locator_candidate.v1", () => {
  it.each([
    ['div:has(> span:text-is("Quantity")) > div > input[type="text"]', "label_anchor", true],
    ['[data-testid="requirement-Material"] input[role="combobox"]', "test_id", true],
    ['role=combobox[name="Search Material"s]', "role", true],
    ['role=textbox[name="Jane Example"s]', "role", false],
    ['div:has(> span:text-is("Bracket for Jane")) > input', "label_anchor", false],
    ['[data-testid="part-row-48213"] input', "test_id", false],
    ['[data-testid="row-9f8e7d6c5b"] input', "test_id", false],
    ["#react-select-5-input", "stable_attribute", false],
    ["#process-multiselect-combobox", "stable_attribute", true],
  ] as const)("%s (%s) accepted: %s", (selector, kind, accepted) => {
    expect(acceptLocatorCandidate({ field: "quantity", selector, kind }, XOMETRY_DRIVER_VOCABULARY)).toBe(accepted);
  });

  it("emits only verified, reviewed candidates with a headed skeleton, and parses back", () => {
    const outcome: DriverOutcome = {
      status: "completed", verified: ["quantity"], matched: { quantity: "25" }, summary,
      candidates: [
        { field: "quantity", selector: 'div:has(> span:text-is("Quantity")) > div > input[type="text"]', kind: "label_anchor" },
        { field: "quantity", selector: 'role=textbox[name="Jane Example"s]', kind: "role" },
      ],
      skeletons: { quantity: '<div><span>Quantity</span><div><input type="text" inputmode="numeric"></div></div>' },
    };
    const candidate = xometryDrivenRepairCandidate(outcome);
    expect(candidate.fields).toEqual([{
      field: "quantity", target: "quantityInputs", insertIndex: 0,
      candidates: [{ kind: "label_anchor", selector: 'div:has(> span:text-is("Quantity")) > div > input[type="text"]' }],
      skeleton: expect.stringMatching(new RegExp(`^${SKELETON_HEADER}\n<div>`)),
    }]);
    expect(JSON.stringify(candidate)).not.toContain("Jane");
    expect(parseDrivenLocatorCandidate(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
    expect(drivenRepairTaskPayload(candidate)).toMatchObject({ vendor: "xometry", failureCode: "driven_locator_candidate.v1" });
  });

  it("gives a stopped run a diagnostic without locators, and rejects tampered payloads", () => {
    const candidate = xometryDrivenRepairCandidate({ status: "stopped", reason: "blocked", field: "material", mutationPossible: false, summary: { ...summary, outcome: "stopped", stopReason: "blocked" } });
    expect(candidate).toMatchObject({ outcome: "stopped", stop: { reason: "blocked", field: "material" }, fields: [] });
    expect(parseDrivenLocatorCandidate({ ...candidate, vendor: "Xometry Inc <script>" })).toBeNull();
    expect(parseDrivenLocatorCandidate({ ...candidate, schema: "other" })).toBeNull();
  });
});
