// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusPurposePermissionsSchema,
} from "./manufacturingCorpusPurposePermissions.js";
import {
  manufacturingCorpusRightsAuthorizationFieldSchemas,
  manufacturingCorpusRightsAuthorizationSchema,
} from "./manufacturingCorpusRightsAuthorization.js";
import {
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusSourceClassSchema,
} from "./manufacturingCorpusVocabulary.js";

const SHA256 = "a".repeat(64);

function makeValidAuthorization() {
  return {
    sourceClass: "synthetic" as const,
    governance: {
      status: "approved" as const,
      policyRef: "governance:ovd-242",
      policyVersion: "1",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    evidence: {
      reference: "repo:synthetic-rights",
      sha256: null,
      basisVersion: "project-authored.v1",
    },
    approval: {
      status: "approved" as const,
      approvedByRole: "data_governance",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    validity: {
      effectiveAt: "2026-07-30T00:00:00Z",
      expiresAt: null,
    },
    tenantScope: {
      kind: "none" as const,
      crossTenantUse: false as const,
    },
    permissions: createDefaultDenyManufacturingCorpusPermissions(),
    redistribution: {
      assets: "full_assets" as const,
      annotations: "full_assets" as const,
      derivedOutputs: "full_assets" as const,
    },
    retention: {
      policyRef: "retention:ovd-242:pending",
      sourceExpiresAt: null,
      derivedExpiresAt: null,
      backupExpiresAt: null,
    },
  };
}

describe("manufacturing corpus rights authorization", () => {
  it("accepts approved, pending, and historically expired records", () => {
    expect(
      manufacturingCorpusRightsAuthorizationSchema.parse(
        makeValidAuthorization(),
      ),
    ).toBeDefined();

    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...makeValidAuthorization(),
        governance: {
          status: "pending",
          policyRef: "governance:pending",
          policyVersion: null,
          approvedByRef: null,
          approvedAt: null,
        },
        approval: {
          status: "pending",
          approvedByRole: null,
          approvedByRef: null,
          approvedAt: null,
        },
        validity: { effectiveAt: null, expiresAt: null },
      }).success,
    ).toBe(true);

    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...makeValidAuthorization(),
        validity: {
          effectiveAt: "2025-01-01T00:00:00Z",
          expiresAt: "2026-01-01T00:00:00Z",
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      field: "governance",
      value: {
        status: "pending",
        policyRef: "governance:pending",
        policyVersion: "1",
        approvedByRef: null,
        approvedAt: null,
      },
    },
    {
      field: "governance",
      value: {
        status: "approved",
        policyRef: "governance:approved",
        policyVersion: null,
        approvedByRef: "user:governance",
        approvedAt: "2026-07-30T00:00:00Z",
      },
    },
    {
      field: "approval",
      value: {
        status: "pending",
        approvedByRole: "data_governance",
        approvedByRef: null,
        approvedAt: null,
      },
    },
    {
      field: "approval",
      value: {
        status: "approved",
        approvedByRole: null,
        approvedByRef: "user:governance",
        approvedAt: "2026-07-30T00:00:00Z",
      },
    },
  ])("rejects contradictory $field provenance", ({ field, value }) => {
    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...makeValidAuthorization(),
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("orders governance, approval, and validity fail closed", () => {
    const authorization = makeValidAuthorization();
    const contradictions = [
      {
        governance: {
          status: "pending",
          policyRef: "governance:pending",
          policyVersion: null,
          approvedByRef: null,
          approvedAt: null,
        },
      },
      {
        governance: {
          ...authorization.governance,
          approvedAt: "2026-07-31T00:00:00Z",
        },
      },
      { validity: { effectiveAt: null, expiresAt: null } },
      {
        approval: {
          status: "pending",
          approvedByRole: null,
          approvedByRef: null,
          approvedAt: null,
        },
      },
      { validity: { effectiveAt: null, expiresAt: "2026-08-01T00:00:00Z" } },
      {
        validity: {
          effectiveAt: "2026-08-01T00:00:00Z",
          expiresAt: "2026-08-01T00:00:00Z",
        },
      },
    ];

    for (const contradiction of contradictions) {
      expect(
        manufacturingCorpusRightsAuthorizationSchema.safeParse({
          ...authorization,
          ...contradiction,
        }).success,
      ).toBe(false);
    }
  });

  it("requires one isolated tenant and hashed evidence for customer data", () => {
    const customerAuthorization = {
      ...makeValidAuthorization(),
      sourceClass: "consented_customer" as const,
      evidence: {
        reference: "consent:customer-rights",
        sha256: SHA256,
        basisVersion: "customer-consent.v1",
      },
      tenantScope: {
        kind: "single_tenant" as const,
        tenantRef: "tenant:customer",
        crossTenantUse: false as const,
      },
    };

    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse(
        customerAuthorization,
      ).success,
    ).toBe(true);
    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...customerAuthorization,
        evidence: { ...customerAuthorization.evidence, sha256: null },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...customerAuthorization,
        tenantScope: { kind: "none", crossTenantUse: false },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...customerAuthorization,
        tenantScope: {
          kind: "single_tenant",
          tenantRef: "tenant:customer",
          crossTenantUse: true,
        },
      }).success,
    ).toBe(false);
  });

  it("uses the exact prerequisite schema bindings", () => {
    expect(manufacturingCorpusRightsAuthorizationFieldSchemas.sourceClass).toBe(
      manufacturingCorpusSourceClassSchema,
    );
    expect(manufacturingCorpusRightsAuthorizationFieldSchemas.permissions).toBe(
      manufacturingCorpusPurposePermissionsSchema,
    );
    expect(
      manufacturingCorpusRightsAuthorizationFieldSchemas.redistribution.shape
        .assets,
    ).toBe(manufacturingCorpusRedistributionLevelSchema);
  });

  it.each([
    { futureField: true },
    { deletion: { state: "none" } },
    { evidence: { ...makeValidAuthorization().evidence, reference: " " } },
    {
      governance: {
        ...makeValidAuthorization().governance,
        approvedAt: "2026-07-30T00:00:00+00:00",
      },
    },
    {
      retention: {
        ...makeValidAuthorization().retention,
        futureRetentionRule: true,
      },
    },
  ])("rejects unknown or malformed authorization input", (change) => {
    expect(
      manufacturingCorpusRightsAuthorizationSchema.safeParse({
        ...makeValidAuthorization(),
        ...change,
      }).success,
    ).toBe(false);
  });
});
