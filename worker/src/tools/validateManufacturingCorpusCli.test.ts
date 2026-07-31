// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  ManufacturingCorpusAnnotation,
  ManufacturingCorpusManifest,
} from "../benchmarks/manufacturingCorpusContract.js";
import type {
  ManufacturingCorpusFilesystemValidationResult,
  PrepareManufacturingCorpusFilesystemOptions,
} from "../benchmarks/manufacturingCorpusFilesystem.js";
import {
  MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION,
  type EvaluateManufacturingCorpusPolicyInput,
  type ManufacturingCorpusPolicyReport,
} from "../benchmarks/manufacturingCorpusPolicy.js";
import {
  MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
  type ManufacturingCorpusPolicyPreflightInput,
  type ManufacturingCorpusPolicyPreflightPlan,
} from "../benchmarks/manufacturingCorpusPolicyPreflight.js";
import {
  parseValidateManufacturingCorpusCliArguments,
  runValidateManufacturingCorpusCli,
  type ManufacturingCorpusCliDependencies,
} from "./validateManufacturingCorpusCli.js";

const VALID_ARGS = [
  "--manifest",
  "relative/manifest.json",
  "--evaluation-at",
  "2026-07-30T00:00:00Z",
] as const;

function manifest(caseIds = ["case-a"]): ManufacturingCorpusManifest {
  return {
    corpusVersion: "0.1.0",
    cases: caseIds.map((caseId) => ({
      caseId,
      annotationArtifact: { artifactId: `annotation-${caseId}` },
    })),
  } as ManufacturingCorpusManifest;
}

function annotation(caseId: string): ManufacturingCorpusAnnotation {
  const evidence = [{ artifactId: `source-${caseId}`, locator: "face-1" }];
  return {
    schemaVersion: "manufacturing-corpus-annotation.v1",
    annotationRevision: "1.0.0",
    caseId,
    review: {
      state: "approved",
      reviewerRole: "manufacturing_reviewer",
      reviewerRef: "user:reviewer",
      reviewedAt: "2026-07-29T00:00:00Z",
      reviewRef: "review:case",
      reviewPolicyVersion: "1",
    },
    expected: {
      productStructure: {
        definitionCount: { state: "known", value: 1, evidence },
        occurrenceCount: { state: "known", value: 1, evidence },
      },
      units: {
        length: { state: "known", value: "mm", evidence },
      },
      commonFeatures: [],
      requirements: [],
      candidateRoutes: [],
      unsupportedStates: [],
      execution: { outcome: "success", diagnosticCodes: [] },
    },
  };
}

function annotationBytes(caseId: string) {
  return new TextEncoder().encode(JSON.stringify(annotation(caseId)));
}

function plan(
  authorizedCaseIds: readonly string[],
  corpusInvalid = false,
): ManufacturingCorpusPolicyPreflightPlan {
  return {
    processorId: MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
    evaluationAt: "2026-07-30T00:00:00Z",
    corpusInvalid,
    corpusInvalidCodes: corpusInvalid ? ["artifact_root_missing"] : [],
    authorizedCaseIds: [...authorizedCaseIds],
    caseDecisions: authorizedCaseIds.map((caseId) => ({
      caseId,
      authorizationState: "authorized",
      policyBlockerCodes: [],
      corpusInvalidCodes: [],
    })),
  };
}

function validation(
  caseIds: readonly string[],
  bytes = new Map(caseIds.map((caseId) => [caseId, annotationBytes(caseId)])),
): ManufacturingCorpusFilesystemValidationResult {
  return {
    state: "validated",
    integrityPassed: true,
    manifestSha256: "a".repeat(64),
    caseResults: caseIds.map((caseId) => ({
      caseId,
      state: "passed",
      diagnosticCodes: [],
    })),
    diagnostics: [],
    verifiedAnnotationBytesByCaseId: bytes,
  };
}

function report(hasGap: boolean): ManufacturingCorpusPolicyReport {
  return {
    schemaVersion: MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION,
    processorId: MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
    corpusVersion: "0.1.0",
    evaluationAt: "2026-07-30T00:00:00Z",
    corpusInvalid: false,
    corpusInvalidCodes: [],
    promotionBlocked: hasGap,
    caseResults: [],
    coverage: [
      {
        processFamily: "cnc_milling",
        qualificationTarget: "broad_estimate",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
        presentPackages: 1,
        integrityPassedPackages: 1,
        eligiblePackages: hasGap ? 0 : 1,
        eligibleConsentedRealPackages: 0,
        promotionBlocked: hasGap,
        gaps: hasGap
          ? [
              {
                code: "minimum_packages_not_met",
                required: 1,
                actual: 0,
                deficit: 1,
              },
            ]
          : [],
      },
    ],
  };
}

function harness(input?: {
  manifest?: ManufacturingCorpusManifest;
  plan?: ManufacturingCorpusPolicyPreflightPlan;
  validation?: ManufacturingCorpusFilesystemValidationResult;
  report?: ManufacturingCorpusPolicyReport;
}) {
  const corpusManifest = input?.manifest ?? manifest();
  const preflight = input?.plan ?? plan(["case-a"]);
  const integrity = input?.validation ?? validation(preflight.authorizedCaseIds);
  const policyReport = input?.report ?? report(false);
  const calls = {
    prepare: [] as PrepareManufacturingCorpusFilesystemOptions[],
    preflight: [] as ManufacturingCorpusPolicyPreflightInput[],
    validate: [] as Array<readonly string[]>,
    evaluate: [] as EvaluateManufacturingCorpusPolicyInput[],
  };
  const dependencies: ManufacturingCorpusCliDependencies = {
    prepareFilesystem: async (options) => {
      calls.prepare.push(options);
      return {
        state: "prepared",
        prepared: {
          manifest: corpusManifest,
          manifestSha256: "a".repeat(64),
          validateArtifacts: async (caseIds) => {
            calls.validate.push(caseIds);
            return integrity;
          },
        },
      };
    },
    planIntegrityAccess: (value) => {
      calls.preflight.push(value);
      return preflight;
    },
    evaluatePolicy: (value) => {
      calls.evaluate.push(value);
      return policyReport;
    },
    serializePolicyReport: () => "CANONICAL REPORT\n",
  };
  return { calls, dependencies };
}

function stderrErrors(stderr: string) {
  return (
    JSON.parse(stderr) as {
      errors: Array<{
        source: string;
        code: string;
        option: string | null;
        recordKind: string | null;
        recordId: string | null;
      }>;
    }
  ).errors;
}

describe("validate manufacturing corpus CLI", () => {
  it("parses spaced options, repeated roots, and a relative manifest", () => {
    const parsed = parseValidateManufacturingCorpusCliArguments([
      ...VALID_ARGS,
      "--evaluation-tenant",
      "tenant:alpha",
      "--root",
      "private=/absolute/private",
      "--root",
      "public=/absolute/public=archive",
      "--strict-coverage",
    ]);
    expect(parsed.state).toBe("parsed");
    if (parsed.state !== "parsed") {
      return;
    }
    expect(parsed.value).toMatchObject({
      manifestPath: "relative/manifest.json",
      evaluationTenantRef: "tenant:alpha",
      strictCoverage: true,
    });
    expect([...parsed.value.externalBindings]).toEqual([
      ["private", "/absolute/private"],
      ["public", "/absolute/public=archive"],
    ]);
  });

  it.each([
    [[], ["cli_evaluation_at_required", "cli_manifest_required"]],
    [
      ["--manifest=x", "--evaluation-at=2026-07-30T00:00:00Z"],
      [
        "cli_evaluation_at_required",
        "cli_manifest_required",
        "cli_unknown_argument",
      ],
    ],
    [
      ["--manifest", "--evaluation-at"],
      ["cli_missing_option_value", "cli_missing_option_value"],
    ],
    [
      [
        "--manifest",
        "first.json",
        "--manifest",
        "--evaluation-at",
        "2026-07-30T00:00:00Z",
      ],
      ["cli_duplicate_option", "cli_missing_option_value"],
    ],
    [
      [...VALID_ARGS, "--wat", "sentinel-secret"],
      ["cli_unknown_argument"],
    ],
    [
      [
        ...VALID_ARGS,
        "--manifest",
        "second.json",
        "--evaluation-at",
        "2026-07-31T00:00:00Z",
        "--evaluation-tenant",
        "tenant:a",
        "--evaluation-tenant",
        "tenant:b",
        "--strict-coverage",
        "--strict-coverage",
      ],
      [
        "cli_duplicate_option",
        "cli_duplicate_option",
        "cli_duplicate_option",
        "cli_duplicate_option",
      ],
    ],
    [
      ["--manifest", "\0bad", "--evaluation-at", "2026-07-30T00:00:00Z"],
      ["cli_manifest_path_invalid"],
    ],
    [
      ["--manifest", "m.json", "--evaluation-at", "2026-07-30T00:00:00+00:00"],
      ["cli_evaluation_at_invalid"],
    ],
    [
      [...VALID_ARGS, "--evaluation-tenant", "   "],
      ["cli_evaluation_tenant_invalid"],
    ],
    [
      [...VALID_ARGS, "--root", "missing-expression"],
      ["cli_root_binding_invalid"],
    ],
    [
      [...VALID_ARGS, "--root", "INVALID=/absolute"],
      ["cli_root_id_invalid"],
    ],
    [
      [...VALID_ARGS, "--root", "private=relative/path"],
      ["cli_root_path_not_absolute"],
    ],
    [
      [
        ...VALID_ARGS,
        "--root",
        "private=/absolute/a",
        "--root",
        "private=/absolute/b",
      ],
      ["cli_root_id_duplicate"],
    ],
  ] as const)("rejects invalid argument forms", async (args, expectedCodes) => {
    const dependencies = harness().dependencies;
    const prepare = vi.spyOn(dependencies, "prepareFilesystem");
    const result = await runValidateManufacturingCorpusCli(args, dependencies);
    const errors = stderrErrors(result.stderr);
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(errors.map((error) => error.code)).toEqual(expectedCodes);
    expect(result.stderr).not.toContain("sentinel-secret");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("passes parsed roots and tenant to preparation and preflight", async () => {
    const { calls, dependencies } = harness();
    const result = await runValidateManufacturingCorpusCli(
      [
        ...VALID_ARGS,
        "--evaluation-tenant",
        " tenant:alpha ",
        "--root",
        "private=/absolute/private",
      ],
      dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.prepare[0].manifestPath).toBe("relative/manifest.json");
    expect([...(calls.prepare[0].externalBindings ?? [])]).toEqual([
      ["private", "/absolute/private"],
    ]);
    expect(calls.preflight[0].evaluationTenantRef).toBe(" tenant:alpha ");
  });

  it("stops on corpus-invalid preflight before artifact validation", async () => {
    const invalidPlan: ManufacturingCorpusPolicyPreflightPlan = {
      ...plan([]),
      corpusInvalid: true,
      corpusInvalidCodes: ["artifact_root_missing"],
      caseDecisions: [
        {
          caseId: "case-a",
          authorizationState: "corpus_invalid",
          policyBlockerCodes: [],
          corpusInvalidCodes: ["artifact_root_missing"],
        },
      ],
    };
    const { calls, dependencies } = harness({ plan: invalidPlan });
    const result = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      dependencies,
    );
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(calls.validate).toEqual([]);
    expect(stderrErrors(result.stderr)).toEqual([
      {
        source: "policy",
        code: "artifact_root_missing",
        option: null,
        recordKind: "case",
        recordId: "case-a",
      },
    ]);
  });

  it("validates and decodes only tenant-authorized cases", async () => {
    const bytes = new Map<string, Uint8Array>([
      ["case-a", new Uint8Array([0xff])],
      ["case-b", annotationBytes("case-b")],
    ]);
    const authorizedPlan = plan(["case-b"]);
    authorizedPlan.caseDecisions.unshift({
      caseId: "case-a",
      authorizationState: "ineligible",
      policyBlockerCodes: ["evaluation_tenant_mismatch"],
      corpusInvalidCodes: [],
    });
    const { calls, dependencies } = harness({
      manifest: manifest(["case-a", "case-b"]),
      plan: authorizedPlan,
      validation: validation(["case-b"], bytes),
    });
    const result = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.validate).toEqual([["case-b"]]);
    expect(calls.evaluate[0].verifiedAnnotations).toMatchObject([
      {
        caseId: "case-b",
        annotationArtifactId: "annotation-case-b",
      },
    ]);
  });

  it.each([
    [
      new Uint8Array([0xff]),
      "annotation_json_invalid",
      "annotation",
      "annotation-case-a",
    ],
    [
      new TextEncoder().encode("{"),
      "annotation_json_invalid",
      "annotation",
      "annotation-case-a",
    ],
    [
      new TextEncoder().encode("{}"),
      "annotation_schema_invalid",
      "annotation",
      "annotation-case-a",
    ],
    [
      annotationBytes("case-b"),
      "annotation_case_mismatch",
      "case",
      "case-a",
    ],
  ] as const)(
    "fails invalid verified annotation bytes",
    async (bytes, code, recordKind, recordId) => {
      const { dependencies } = harness({
        validation: validation(["case-a"], new Map([["case-a", bytes]])),
      });
      const result = await runValidateManufacturingCorpusCli(
        VALID_ARGS,
        dependencies,
      );
      expect(result).toMatchObject({ exitCode: 2, stdout: "" });
      expect(stderrErrors(result.stderr)).toEqual([
        {
          source: "annotation",
          code,
          option: null,
          recordKind,
          recordId,
        },
      ]);
    },
  );

  it("returns deterministic private preparation and integrity failures", async () => {
    const dependencies = harness().dependencies;
    const preparationFailureDependencies = {
      ...dependencies,
      prepareFilesystem: async () =>
        ({
          state: "failed",
          diagnostics: [
            {
              code: "manifest_root_missing",
              recordKind: "root",
              recordId: "private-root",
            },
          ],
        }) as const,
    };
    const first = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      preparationFailureDependencies,
    );
    const second = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      preparationFailureDependencies,
    );
    expect(first).toEqual(second);
    expect(first.stderr).not.toContain("relative/manifest.json");

    const integrityFailure = {
      ...validation([]),
      integrityPassed: false,
      diagnostics: [
        {
          code: "artifact_sha256_mismatch",
          recordKind: "artifact",
          recordId: "annotation-case-a",
        },
      ],
    } satisfies ManufacturingCorpusFilesystemValidationResult;
    const failed = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      harness({ validation: integrityFailure }).dependencies,
    );
    expect(failed).toMatchObject({ exitCode: 2, stdout: "" });
  });

  it("rejects malformed filesystem metadata without serializing it", async () => {
    const dependencies = harness().dependencies;
    const privateRecordKind = "/private/sentinel-path";
    const result = await runValidateManufacturingCorpusCli(VALID_ARGS, {
      ...dependencies,
      prepareFilesystem: async () =>
        ({
          state: "failed",
          diagnostics: [
            {
              code: "manifest_missing",
              recordKind: privateRecordKind,
              recordId: "manifest",
            },
          ],
        }) as never,
    });

    expect(stderrErrors(result.stderr)).toEqual([
      {
        source: "internal",
        code: "cli_internal_failure",
        option: null,
        recordKind: null,
        recordId: null,
      },
    ]);
    expect(result.stderr).not.toContain(privateRecordKind);
  });

  it("freezes missing root value metadata", async () => {
    const result = await runValidateManufacturingCorpusCli(
      [...VALID_ARGS, "--root"],
      harness().dependencies,
    );

    expect(stderrErrors(result.stderr)).toEqual([
      {
        source: "argument",
        code: "cli_missing_option_value",
        option: "root",
        recordKind: null,
        recordId: null,
      },
    ]);
  });

  it("keeps canonical stdout byte-identical across strict coverage modes", async () => {
    const dependencies = harness({ report: report(true) }).dependencies;
    const normal = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      dependencies,
    );
    const strict = await runValidateManufacturingCorpusCli(
      [...VALID_ARGS, "--strict-coverage"],
      dependencies,
    );
    expect(normal).toEqual({
      exitCode: 0,
      stdout: "CANONICAL REPORT\n",
      stderr: "",
    });
    expect(strict).toEqual({
      exitCode: 1,
      stdout: normal.stdout,
      stderr: "",
    });

    const fulfilled = await runValidateManufacturingCorpusCli(
      [...VALID_ARGS, "--strict-coverage"],
      harness({ report: report(false) }).dependencies,
    );
    expect(fulfilled.exitCode).toBe(0);
  });

  it("returns byte-identical results for repeated equivalent invocations", async () => {
    const dependencies = harness({ report: report(true) }).dependencies;
    const args = [
      ...VALID_ARGS,
      "--evaluation-tenant",
      "tenant:alpha",
      "--root",
      "private=/absolute/private",
    ];
    const first = await runValidateManufacturingCorpusCli(args, dependencies);
    const second = await runValidateManufacturingCorpusCli(args, dependencies);

    expect(second).toEqual(first);
  });

  it("maps unexpected dependency failures to one private internal error", async () => {
    const dependencies = harness().dependencies;
    const throwingDependencies = {
      ...dependencies,
      prepareFilesystem: async () => {
        throw new Error("/private/sentinel-path");
      },
    };
    const result = await runValidateManufacturingCorpusCli(
      VALID_ARGS,
      throwingDependencies,
    );
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(stderrErrors(result.stderr)).toEqual([
      {
        source: "internal",
        code: "cli_internal_failure",
        option: null,
        recordKind: null,
        recordId: null,
      },
    ]);
    expect(result.stderr).not.toContain("sentinel");
  });
});
