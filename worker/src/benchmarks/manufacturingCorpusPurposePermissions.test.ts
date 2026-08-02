// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  ManufacturingCorpusPermissionGrant,
  ManufacturingCorpusProcessorExecutionLocation,
} from "./manufacturingCorpusPurposePermissions.js";
import {
  DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS,
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
  MANUFACTURING_CORPUS_PROCESSOR_EXECUTION_LOCATIONS,
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusPermissionGrantSchema,
  manufacturingCorpusPermissionPurposeSchema,
  manufacturingCorpusProcessorExecutionLocationSchema,
  manufacturingCorpusPurposePermissionsSchema,
} from "./manufacturingCorpusPurposePermissions.js";

function createAllowedGrant(
  executionLocation: ManufacturingCorpusProcessorExecutionLocation =
    "local_only",
): ManufacturingCorpusPermissionGrant {
  return {
    allowed: true,
    artifactClasses: ["cad_model"],
    processorPolicy: {
      executionLocation,
      allowedProcessors: ["geometry_sdk.v1"],
      rawOutputRetentionAllowed: false,
    },
  };
}

describe("manufacturing corpus purpose permissions", () => {
  it("accepts only declared purposes and processor execution locations", () => {
    for (const purpose of MANUFACTURING_CORPUS_PERMISSION_PURPOSES) {
      expect(manufacturingCorpusPermissionPurposeSchema.parse(purpose)).toBe(
        purpose,
      );
    }
    for (const location of MANUFACTURING_CORPUS_PROCESSOR_EXECUTION_LOCATIONS) {
      expect(
        manufacturingCorpusProcessorExecutionLocationSchema.parse(location),
      ).toBe(location);
    }
    expect(
      manufacturingCorpusPermissionPurposeSchema.safeParse("futurePurpose")
        .success,
    ).toBe(false);
    expect(
      manufacturingCorpusProcessorExecutionLocationSchema.safeParse(
        "unspecified",
      ).success,
    ).toBe(false);
  });

  it("requires every purpose independently and rejects unknown purposes", () => {
    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    expect(Object.keys(permissions)).toEqual([
      ...MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
    ]);

    const { publication: _publication, ...missingPublication } = permissions;
    expect(
      manufacturingCorpusPurposePermissionsSchema.safeParse(
        missingPublication,
      ).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPurposePermissionsSchema.safeParse({
        ...permissions,
        futurePurpose: permissions.publication,
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "artifact access",
      (grant: ManufacturingCorpusPermissionGrant) => {
        grant.artifactClasses.push("cad_model");
      },
    ],
    [
      "approved-service execution",
      (grant: ManufacturingCorpusPermissionGrant) => {
        grant.processorPolicy.executionLocation = "approved_service";
      },
    ],
    [
      "a processor allowlist",
      (grant: ManufacturingCorpusPermissionGrant) => {
        grant.processorPolicy.allowedProcessors.push("geometry_sdk.v1");
      },
    ],
    [
      "raw output retention",
      (grant: ManufacturingCorpusPermissionGrant) => {
        grant.processorPolicy.rawOutputRetentionAllowed = true;
      },
    ],
  ] as const)("rejects %s when a purpose is denied", (_label, mutate) => {
    const grant = createDefaultDenyManufacturingCorpusPermissions().publication;
    mutate(grant);
    expect(manufacturingCorpusPermissionGrantSchema.safeParse(grant).success).toBe(
      false,
    );
  });

  it("requires artifacts and an exact processor for every allowed grant", () => {
    const missingArtifacts = createAllowedGrant();
    missingArtifacts.artifactClasses = [];
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse(missingArtifacts)
        .success,
    ).toBe(false);

    const unspecifiedLocalProcessor = createAllowedGrant();
    unspecifiedLocalProcessor.processorPolicy.allowedProcessors = [];
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse(
        unspecifiedLocalProcessor,
      ).success,
    ).toBe(false);
  });

  it("rejects duplicates and unknown grant or processor fields", () => {
    const duplicateArtifacts = createAllowedGrant();
    duplicateArtifacts.artifactClasses.push("cad_model");
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse(duplicateArtifacts)
        .success,
    ).toBe(false);

    const duplicateProcessors = createAllowedGrant();
    duplicateProcessors.processorPolicy.allowedProcessors.push(
      "geometry_sdk.v1",
    );
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse(duplicateProcessors)
        .success,
    ).toBe(false);

    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...createAllowedGrant(),
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...createAllowedGrant(),
        processorPolicy: {
          ...createAllowedGrant().processorPolicy,
          futureField: true,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts local and approved-service grants without widening another purpose", () => {
    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    permissions.geometrySdkEvaluation = createAllowedGrant();
    permissions.quoteOutcomeUse = createAllowedGrant("approved_service");
    permissions.quoteOutcomeUse.processorPolicy.allowedProcessors = [
      "approved.quote_processor.v1",
    ];

    const parsed = manufacturingCorpusPurposePermissionsSchema.parse(permissions);
    expect(parsed.geometrySdkEvaluation.allowed).toBe(true);
    expect(parsed.geometrySdkEvaluation.processorPolicy.executionLocation).toBe(
      "local_only",
    );
    expect(parsed.quoteOutcomeUse.allowed).toBe(true);
    expect(parsed.quoteOutcomeUse.processorPolicy.executionLocation).toBe(
      "approved_service",
    );
    expect(parsed.localParserEvaluation.allowed).toBe(false);
    expect(parsed.modelValidation.allowed).toBe(false);
  });

  it("never lets parser permission imply SDK, validation, training, or publication", () => {
    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    permissions.localParserEvaluation = createAllowedGrant();
    permissions.localParserEvaluation.processorPolicy.allowedProcessors = [
      "local.parser.v1",
    ];

    const parsed = manufacturingCorpusPurposePermissionsSchema.parse(permissions);
    expect(parsed.localParserEvaluation.allowed).toBe(true);
    expect(parsed.geometrySdkEvaluation.allowed).toBe(false);
    expect(parsed.modelValidation.allowed).toBe(false);
    expect(parsed.modelTraining.allowed).toBe(false);
    expect(parsed.publication.allowed).toBe(false);
  });

  it("deep-freezes exported defaults and returns isolated mutable factories", () => {
    expect(Object.isFrozen(DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS)).toBe(
      true,
    );
    for (const purpose of MANUFACTURING_CORPUS_PERMISSION_PURPOSES) {
      const grant = DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS[purpose];
      expect(Object.isFrozen(grant)).toBe(true);
      expect(Object.isFrozen(grant.artifactClasses)).toBe(true);
      expect(Object.isFrozen(grant.processorPolicy)).toBe(true);
      expect(Object.isFrozen(grant.processorPolicy.allowedProcessors)).toBe(
        true,
      );
    }
    expect(
      Reflect.set(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication,
        "allowed",
        true,
      ),
    ).toBe(false);

    const first = createDefaultDenyManufacturingCorpusPermissions();
    const second = createDefaultDenyManufacturingCorpusPermissions();
    first.publication.allowed = true;
    first.publication.artifactClasses.push("cad_model");
    first.publication.processorPolicy.allowedProcessors.push("publisher.v1");

    expect(first.humanAnnotation.allowed).toBe(false);
    expect(first.humanAnnotation.artifactClasses).toEqual([]);
    expect(first.humanAnnotation.processorPolicy.allowedProcessors).toEqual([]);
    expect(second.publication.allowed).toBe(false);
    expect(second.publication.artifactClasses).toEqual([]);
    expect(second.publication.processorPolicy.allowedProcessors).toEqual([]);
    expect(first.publication).not.toBe(first.humanAnnotation);
    expect(first.publication).not.toBe(second.publication);
    expect(first.publication.artifactClasses).not.toBe(
      first.humanAnnotation.artifactClasses,
    );
    expect(first.publication.processorPolicy.allowedProcessors).not.toBe(
      second.publication.processorPolicy.allowedProcessors,
    );
  });
});
