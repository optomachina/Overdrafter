import { describe, expect, it } from "vitest";
import * as vocabulary from "./ovd419-failure-vocabulary.mjs";

const categories = [
  {
    name: "promotion failure stages",
    predicate: vocabulary.isPromotionFailureStage,
    allowed: `unknown observe_before_job evaluate_before_job replace_job
      observe_after_job verify_after_job observe_before_service evaluate_before_service
      replace_service observe_after_service verify_after_service verify_final_containment`
      .split(/\s+/),
  },
  {
    name: "probe failure stages",
    predicate: vocabulary.isProbeFailureStage,
    allowed: `unknown validate_request initial_inventory initial_containment baseline_snapshot
      pre_execution_inventory pre_execution_snapshot pre_execution_containment
      pre_execution_job_identity execute_probe validate_probe_result observe_execution_completion
      post_execution_snapshot verify_sequence_completion final_inventory final_containment`
      .split(/\s+/),
  },
  {
    name: "probe failure codes",
    predicate: vocabulary.isProbeFailureCode,
    allowed: `probe_image_invalid probe_operations_missing probe_inventory_operation_failed
      probe_inventory_invalid probe_inventory_changed containment_operation_failed
      probe_preflight_failed snapshot_operation_failed snapshot_version_invalid
      snapshot_changed_before_probe probe_job_identity_invalid probe_job_observation_operation_failed
      probe_job_identity_changed probe_execution_operation_failed probe_execution_contract_failed
      probe_evidence_failed probe_inventory_completion_mismatch snapshot_changed_by_probe
      probe_final_containment_failed observation_snapshot_failed probe_sequence_failed`
      .split(/\s+/),
  },
];

describe("OVD-419 failure vocabulary", () => {
  it("exports only the three predicates and keeps the allowlists private", () => {
    expect(Object.keys(vocabulary).sort()).toEqual([
      "isProbeFailureCode",
      "isProbeFailureStage",
      "isPromotionFailureStage",
    ]);
    for (const exported of Object.values(vocabulary)) {
      expect(typeof exported).toBe("function");
    }
  });

  describe.each(categories)("$name", ({ predicate, allowed }) => {
    it.each(allowed)("accepts the exact value %s", (value) => {
      expect(predicate(value)).toBe(true);
    });

    it("rejects values belonging only to another category", () => {
      const otherValues = categories
        .flatMap((category) => category.allowed)
        .filter((value) => !allowed.includes(value));
      for (const value of otherValues) {
        expect(predicate(value)).toBe(false);
      }
    });

    it("rejects case, whitespace, prefix, and suffix near-misses", () => {
      for (const value of allowed) {
        const nearMisses = [
          value.toUpperCase(), ` ${value}`, `${value}\n`, `x_${value}`, `${value}_x`,
        ];
        for (const nearMiss of nearMisses) {
          expect(predicate(nearMiss)).toBe(false);
        }
      }
    });

    it.each([
      ["missing", undefined], ["null", null], ["false", false], ["true", true],
      ["zero", 0], ["one", 1], ["NaN", Number.NaN], ["bigint", 1n],
      ["object", {}], ["array", []], ["symbol", Symbol("unknown")],
      ["empty string", ""], ["arbitrary string", "unrecognized_failure"],
    ])("rejects %s", (_label, value) => {
      expect(predicate(value)).toBe(false);
    });

    it("rejects non-strings that could coerce to each allowed value", () => {
      for (const value of allowed) {
        const coercibleValues = [
          Object(value), [value], { toString: () => value },
          { [Symbol.toPrimitive]: () => value },
        ];
        for (const coercible of coercibleValues) {
          expect(predicate(coercible)).toBe(false);
        }
      }
    });

    it("does not invoke input coercion hooks", () => {
      expect(predicate({
        [Symbol.toPrimitive]() {
          throw new Error("Input must not be coerced");
        },
      })).toBe(false);
    });
  });
});
