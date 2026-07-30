// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusPermissionGrantSchema,
} from "./manufacturingCorpusVocabulary.js";
import {
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  manufacturingCorpusRightsSchema,
} from "./manufacturingCorpusRightsContract.js";

const SHA256 = "a".repeat(64);

function makeAllowedGrant() {
  return {
    allowed: true,
    artifactClasses: ["cad_model" as const],
    processorPolicy: {
      executionLocation: "local_only" as const,
      allowedProcessors: ["geometry_sdk"],
      rawOutputRetentionAllowed: false,
    },
  };
}

function makeValidRights() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
    rightsId: "rights-synthetic",
    sourceClass: "synthetic" as const,
    rightsBasisCode: "project_authored_synthetic",
    governance: {
      status: "approved" as const,
      policyRef: "governance:ovd-242",
      policyVersion: "1",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    evidence: {
      reference: "repo:ovd-263:synthetic",
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
    revocation: {
      state: "active" as const,
      revokedAt: null,
      reasonCode: null,
      evidenceRef: null,
    },
    deletion: {
      state: "none" as const,
      requestRef: null,
      requestedAt: null,
      sourcePurgedAt: null,
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: null,
      purgeVerification: null,
    },
    legalHold: {
      state: "inactive" as const,
      reference: null,
      effectiveAt: null,
    },
  };
}

function makeCustomerRights() {
  return {
    ...makeValidRights(),
    rightsId: "rights-customer",
    sourceClass: "consented_customer" as const,
    evidence: {
      reference: "consent:opaque-reference",
      sha256: SHA256,
      basisVersion: "customer-consent.v1",
    },
    tenantScope: {
      kind: "single_tenant" as const,
      tenantRef: "tenant:opaque-reference",
      crossTenantUse: false as const,
    },
    redistribution: {
      assets: "internal_only" as const,
      annotations: "internal_only" as const,
      derivedOutputs: "internal_only" as const,
    },
  };
}

describe("manufacturing corpus rights contract", () => {
  it("parses a complete v1 record and rejects future shapes", () => {
    const rights = makeValidRights();
    expect(manufacturingCorpusRightsSchema.parse(rights)).toEqual(rights);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        schemaVersion: "manufacturing-corpus-rights.v2",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          ...rights.governance,
          futureField: true,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps a fully pending governance and approval record representable", () => {
    const rights = makeValidRights();
    const pending = {
      ...rights,
      governance: {
        status: "pending",
        policyRef: "governance:ovd-242",
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
      validity: {
        effectiveAt: null,
        expiresAt: null,
      },
    };

    expect(manufacturingCorpusRightsSchema.safeParse(pending).success).toBe(
      true,
    );
  });

  it("preserves independent purpose grants from the shared vocabulary", () => {
    const rights = makeValidRights();
    rights.permissions.geometrySdkEvaluation = makeAllowedGrant();

    const parsed = manufacturingCorpusRightsSchema.parse(rights);
    expect(parsed.permissions.geometrySdkEvaluation.allowed).toBe(true);
    expect(parsed.permissions.localParserEvaluation.allowed).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        ...makeAllowedGrant(),
        processorPolicy: {
          ...makeAllowedGrant().processorPolicy,
          allowedProcessors: [],
        },
      }).success,
    ).toBe(false);
  });

  it("requires hashed evidence and one tenant for customer-origin rights", () => {
    expect(
      manufacturingCorpusRightsSchema.parse(makeCustomerRights()),
    ).toBeDefined();
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        evidence: {
          ...makeCustomerRights().evidence,
          sha256: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        tenantScope: {
          kind: "none",
          crossTenantUse: false,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        tenantScope: {
          kind: "single_tenant",
          tenantRef: "tenant:opaque-reference",
          crossTenantUse: true,
        },
      }).success,
    ).toBe(false);
  });

  it("orders governance, approval, validity, and revocation fields", () => {
    const rights = makeValidRights();
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          status: "pending",
          policyRef: "governance:ovd-242",
          policyVersion: null,
          approvedByRef: null,
          approvedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          ...rights.governance,
          approvedByRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        approval: {
          ...rights.approval,
          approvedByRole: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        approval: {
          ...rights.approval,
          approvedByRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          ...rights.governance,
          approvedAt: "2026-07-31T00:00:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        approval: {
          status: "pending",
          approvedByRole: null,
          approvedByRef: null,
          approvedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        validity: {
          effectiveAt: null,
          expiresAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        validity: {
          effectiveAt: "2026-07-30T00:00:00Z",
          expiresAt: "2026-07-29T00:00:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        revocation: {
          state: "revoked",
          revokedAt: null,
          reasonCode: null,
          evidenceRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        revocation: {
          state: "revoked",
          revokedAt: "2026-07-31T00:00:00Z",
          reasonCode: "consent_withdrawn",
          evidenceRef: "revocation:request-1",
        },
      }).success,
    ).toBe(true);
  });

  it("requires ordered purge verification after a deletion request", () => {
    const rights = makeValidRights();
    const completedDeletion = {
      state: "requested" as const,
      requestRef: "deletion:request",
      requestedAt: "2026-07-30T01:00:00Z",
      sourcePurgedAt: "2026-07-30T02:00:00Z",
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: "audit:tombstone",
      purgeVerification: {
        reference: "purge:verification",
        verifiedByRef: "user:data-governance",
        verifiedAt: "2026-07-30T03:00:00Z",
      },
    };

    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: completedDeletion,
      }).success,
    ).toBe(true);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          sourcePurgedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          sourcePurgedAt: "2026-07-30T00:30:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          purgeVerification: {
            ...completedDeletion.purgeVerification,
            verifiedAt: "2026-07-30T00:30:00Z",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          derivedPurgedAt: "2026-07-30T04:00:00Z",
          purgeVerification: {
            ...completedDeletion.purgeVerification,
            verifiedAt: "2026-07-30T03:00:00Z",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          purgeVerification: {
            ...completedDeletion.purgeVerification,
            verifiedAt: "2026-07-30T01:30:00Z",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("prevents purge records during active or released legal holds", () => {
    const rights = makeValidRights();
    const deletion = {
      state: "requested" as const,
      requestRef: "deletion:request",
      requestedAt: "2026-07-30T01:00:00Z",
      sourcePurgedAt: "2026-07-30T02:00:00Z",
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: "audit:tombstone",
      purgeVerification: {
        reference: "purge:verification",
        verifiedByRef: "user:data-governance",
        verifiedAt: "2026-07-30T03:00:00Z",
      },
    };

    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion,
        legalHold: {
          state: "active",
          reference: "legal-hold:case-1",
          effectiveAt: "2026-07-30T01:30:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...deletion,
          sourcePurgedAt: "2026-07-30T04:00:00Z",
          purgeVerification: {
            ...deletion.purgeVerification,
            verifiedAt: "2026-07-30T05:00:00Z",
          },
        },
        legalHold: {
          state: "released",
          reference: "legal-hold:case-1",
          effectiveAt: "2026-07-30T01:30:00Z",
          releasedAt: "2026-07-30T02:30:00Z",
          releaseRef: "legal-hold:release",
        },
      }).success,
    ).toBe(true);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion,
        legalHold: {
          state: "released",
          reference: "legal-hold:case-1",
          effectiveAt: "2026-07-30T01:30:00Z",
          releasedAt: "2026-07-30T02:30:00Z",
          releaseRef: "legal-hold:release",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        legalHold: {
          state: "released",
          reference: "legal-hold:case-1",
          effectiveAt: "2026-07-30T02:00:00Z",
          releasedAt: "2026-07-30T01:00:00Z",
          releaseRef: "legal-hold:release",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps an internally consistent expired record representable", () => {
    const expired = {
      ...makeValidRights(),
      validity: {
        effectiveAt: "2025-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:00:00Z",
      },
      retention: {
        policyRef: "retention:historical",
        sourceExpiresAt: "2026-01-01T00:00:00Z",
        derivedExpiresAt: "2026-02-01T00:00:00Z",
        backupExpiresAt: "2026-03-01T00:00:00Z",
      },
    };

    expect(manufacturingCorpusRightsSchema.parse(expired).validity).toEqual(
      expired.validity,
    );
  });
});
