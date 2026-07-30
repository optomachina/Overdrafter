// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS,
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
  MANUFACTURING_PROCESS_FAMILIES,
  MANUFACTURING_QUALIFICATION_TARGETS,
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusArtifactClassSchema,
  manufacturingCorpusDataClassificationSchema,
  manufacturingCorpusHasDuplicates,
  manufacturingCorpusJsonValueSchema,
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusPermissionGrantSchema,
  manufacturingCorpusPermissionPurposeSchema,
  manufacturingCorpusPurposePermissionsSchema,
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusSha256Schema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingCorpusUtcTimestampSchema,
  manufacturingProcessFamilySchema,
  manufacturingQualificationTargetSchema,
} from "./manufacturingCorpusVocabulary.js";

describe("manufacturing corpus vocabulary", () => {
  it("accepts every declared catalog value and rejects unknown values", () => {
    for (const process of MANUFACTURING_PROCESS_FAMILIES) {
      expect(manufacturingProcessFamilySchema.parse(process)).toBe(process);
    }
    for (const target of MANUFACTURING_QUALIFICATION_TARGETS) {
      expect(manufacturingQualificationTargetSchema.parse(target)).toBe(target);
    }
    for (const schema of [
      manufacturingProcessFamilySchema,
      manufacturingQualificationTargetSchema,
      manufacturingCorpusSourceClassSchema,
      manufacturingCorpusArtifactClassSchema,
      manufacturingCorpusDataClassificationSchema,
      manufacturingCorpusRedistributionLevelSchema,
      manufacturingCorpusPermissionPurposeSchema,
    ]) {
      expect(schema.safeParse("future_value").success).toBe(false);
    }
  });

  it("requires every independent permission purpose", () => {
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
    {
      allowed: false,
      artifactClasses: ["cad_model"],
      processorPolicy: {
        executionLocation: "local_only",
        allowedProcessors: [],
        rawOutputRetentionAllowed: false,
      },
    },
    {
      allowed: false,
      artifactClasses: [],
      processorPolicy: {
        executionLocation: "approved_service",
        allowedProcessors: ["processor"],
        rawOutputRetentionAllowed: true,
      },
    },
    {
      allowed: true,
      artifactClasses: [],
      processorPolicy: {
        executionLocation: "local_only",
        allowedProcessors: ["processor"],
        rawOutputRetentionAllowed: false,
      },
    },
    {
      allowed: true,
      artifactClasses: ["cad_model"],
      processorPolicy: {
        executionLocation: "local_only",
        allowedProcessors: [],
        rawOutputRetentionAllowed: false,
      },
    },
  ])("rejects contradictory permission grant %#", (grant) => {
    expect(manufacturingCorpusPermissionGrantSchema.safeParse(grant).success).toBe(
      false,
    );
  });

  it("rejects unknown grant fields, processor fields, and duplicate declarations", () => {
    const grant = {
      allowed: true,
      artifactClasses: ["cad_model"],
      processorPolicy: {
        executionLocation: "local_only",
        allowedProcessors: ["geometry_sdk"],
        rawOutputRetentionAllowed: false,
      },
    } as const;

    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...grant,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...grant,
        processorPolicy: {
          ...grant.processorPolicy,
          futureField: true,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...grant,
        artifactClasses: ["cad_model", "cad_model"],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...grant,
        processorPolicy: {
          ...grant.processorPolicy,
          allowedProcessors: ["geometry_sdk", "geometry_sdk"],
        },
      }).success,
    ).toBe(false);
  });

  it("allows an exact local processor without implying another purpose", () => {
    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    permissions.geometrySdkEvaluation = {
      allowed: true,
      artifactClasses: ["cad_model"],
      processorPolicy: {
        executionLocation: "local_only",
        allowedProcessors: ["geometry_sdk"],
        rawOutputRetentionAllowed: false,
      },
    };

    const parsed = manufacturingCorpusPurposePermissionsSchema.parse(permissions);
    expect(parsed.geometrySdkEvaluation.allowed).toBe(true);
    expect(parsed.localParserEvaluation.allowed).toBe(false);
  });

  it("deep-freezes the exported defaults and returns independent examples", () => {
    expect(Object.isFrozen(DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS)).toBe(
      true,
    );
    expect(
      Object.isFrozen(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication
          .processorPolicy.allowedProcessors,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication
          .artifactClasses,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication
          .processorPolicy,
      ),
    ).toBe(true);
    expect(
      Reflect.set(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication,
        "allowed",
        true,
      ),
    ).toBe(false);
    expect(
      Reflect.set(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication
          .artifactClasses,
        "0",
        "cad_model",
      ),
    ).toBe(false);
    expect(
      Reflect.set(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication
          .processorPolicy,
        "rawOutputRetentionAllowed",
        true,
      ),
    ).toBe(false);
    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    permissions.publication.allowed = true;
    permissions.publication.artifactClasses.push("cad_model");
    permissions.publication.processorPolicy.allowedProcessors.push(
      "geometry_sdk",
    );
    expect(permissions.humanAnnotation.allowed).toBe(false);
    expect(permissions.humanAnnotation.artifactClasses).toEqual([]);
    expect(
      permissions.humanAnnotation.processorPolicy.allowedProcessors,
    ).toEqual([]);
  });

  it("validates shared scalar boundaries and duplicate detection", () => {
    expect(manufacturingCorpusStableIdSchema.parse("processor.v1-a")).toBe(
      "processor.v1-a",
    );
    for (const value of ["", "Uppercase", "has space"]) {
      expect(manufacturingCorpusStableIdSchema.safeParse(value).success).toBe(
        false,
      );
    }

    expect(manufacturingCorpusOpaqueReferenceSchema.parse(" ref-1 ")).toBe(
      "ref-1",
    );
    expect(manufacturingCorpusOpaqueReferenceSchema.safeParse("   ").success).toBe(
      false,
    );
    expect(
      manufacturingCorpusOpaqueReferenceSchema.safeParse("x".repeat(513))
        .success,
    ).toBe(false);

    expect(manufacturingCorpusSha256Schema.safeParse("a".repeat(64)).success).toBe(
      true,
    );
    expect(manufacturingCorpusSha256Schema.safeParse("A".repeat(64)).success).toBe(
      false,
    );
    expect(manufacturingCorpusSha256Schema.safeParse("a".repeat(63)).success).toBe(
      false,
    );

    expect(
      manufacturingCorpusUtcTimestampSchema.safeParse(
        "2026-07-30T23:59:00.000Z",
      ).success,
    ).toBe(true);
    expect(
      manufacturingCorpusUtcTimestampSchema.safeParse(
        "2026-07-30T23:59:00+00:00",
      ).success,
    ).toBe(false);
    expect(manufacturingCorpusHasDuplicates(["a", "a"])).toBe(true);
    expect(manufacturingCorpusHasDuplicates(["a", "b"])).toBe(false);
  });

  it("accepts JSON values and rejects non-serializable values", () => {
    expect(
      manufacturingCorpusJsonValueSchema.safeParse({
        count: 2,
        nested: [true, null, "value"],
      }).success,
    ).toBe(true);
    for (const value of [
      new Date("2026-07-30T00:00:00Z"),
      undefined,
      () => "value",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      Symbol("value"),
    ]) {
      expect(manufacturingCorpusJsonValueSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});
