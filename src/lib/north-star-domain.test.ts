import { describe, expect, it } from "vitest";
import {
  createWorkspaceDomainSnapshot,
  isArtifactRecord,
  isOverrideRecord,
  isReviewRecord,
  sortArtifactsDeterministically,
  type ArtifactRecord,
} from "./north-star-domain";

const ARTIFACT_A: ArtifactRecord = {
  id: "artifact-a",
  workspaceId: "workspace-1",
  filename: "part-a.step",
  mediaType: "model/step",
  sizeBytes: 1024,
  sha256: "aaa111",
  kind: "cad",
  role: "primary_model",
  sourcePath: "uploads/part-a.step",
  createdAt: "2026-03-29T10:00:00.000Z",
};

const ARTIFACT_B: ArtifactRecord = {
  id: "artifact-b",
  workspaceId: "workspace-1",
  filename: "part-b.step",
  mediaType: "model/step",
  sizeBytes: 2048,
  sha256: "bbb111",
  kind: "cad",
  role: "supporting_model",
  sourcePath: "uploads/part-b.step",
  createdAt: "2026-03-29T10:01:00.000Z",
};

describe("isArtifactRecord", () => {
  it("accepts valid artifact records", () => {
    expect(isArtifactRecord(ARTIFACT_A)).toBe(true);
  });

  it("rejects malformed records", () => {
    expect(isArtifactRecord({ ...ARTIFACT_A, id: "" })).toBe(false);
    expect(isArtifactRecord({ ...ARTIFACT_A, sizeBytes: -1 })).toBe(false);
    expect(isArtifactRecord({ ...ARTIFACT_A, kind: "spreadsheet" })).toBe(false);
    expect(isArtifactRecord({ ...ARTIFACT_A, role: "attachment" })).toBe(false);
  });
});

describe("isReviewRecord", () => {
  it("accepts valid review records and rejects invalid status values", () => {
    expect(
      isReviewRecord({
        id: "review-a",
        workspaceId: "workspace-1",
        artifactId: "artifact-a",
        status: "approved",
        reviewerUserId: "user-1",
        rationale: "looks good",
        reviewedAt: "2026-03-29T11:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isReviewRecord({
        id: "review-b",
        workspaceId: "workspace-1",
        artifactId: "artifact-a",
        status: "accepted",
        reviewerUserId: "user-1",
        rationale: "looks good",
        reviewedAt: "2026-03-29T11:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("isOverrideRecord", () => {
  it("accepts valid overrides and rejects invalid scope or provenance", () => {
    expect(
      isOverrideRecord({
        id: "override-a",
        workspaceId: "workspace-1",
        artifactId: "artifact-a",
        scope: "metadata",
        field: "partNumber",
        value: "A-100",
        provenance: "human",
        createdByUserId: "user-1",
        createdAt: "2026-03-29T11:10:00.000Z",
      }),
    ).toBe(true);
    expect(
      isOverrideRecord({
        id: "override-b",
        workspaceId: "workspace-1",
        artifactId: "artifact-a",
        scope: "layout",
        field: "partNumber",
        value: "A-100",
        provenance: "human",
        createdByUserId: "user-1",
        createdAt: "2026-03-29T11:10:00.000Z",
      }),
    ).toBe(false);
    expect(
      isOverrideRecord({
        id: "override-c",
        workspaceId: "workspace-1",
        artifactId: "artifact-a",
        scope: "metadata",
        field: "partNumber",
        value: "A-100",
        provenance: "operator",
        createdByUserId: "user-1",
        createdAt: "2026-03-29T11:10:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("sortArtifactsDeterministically", () => {
  it("sorts artifacts by digest, filename, and id", () => {
    const sorted = sortArtifactsDeterministically([ARTIFACT_B, ARTIFACT_A]);
    expect(sorted.map((artifact) => artifact.id)).toEqual(["artifact-a", "artifact-b"]);
  });
});

describe("createWorkspaceDomainSnapshot", () => {
  it("keeps only records that belong to the snapshot workspace and known artifacts", () => {
    const snapshot = createWorkspaceDomainSnapshot({
      workspaceId: "workspace-1",
      artifacts: [
        ARTIFACT_B,
        ARTIFACT_A,
        { ...ARTIFACT_B, id: "artifact-other-workspace", workspaceId: "workspace-2" },
      ],
      reviews: [
        {
          id: "review-a",
          workspaceId: "workspace-1",
          artifactId: "artifact-a",
          status: "approved",
          reviewerUserId: "user-1",
          rationale: "looks good",
          reviewedAt: "2026-03-29T11:00:00.000Z",
        },
        {
          id: "review-dangling",
          workspaceId: "workspace-1",
          artifactId: "artifact-missing",
          status: "pending",
          reviewerUserId: null,
          rationale: null,
          reviewedAt: null,
        },
        {
          id: "review-other-workspace",
          workspaceId: "workspace-2",
          artifactId: "artifact-a",
          status: "approved",
          reviewerUserId: "user-2",
          rationale: "wrong workspace",
          reviewedAt: "2026-03-29T11:05:00.000Z",
        },
      ],
      overrides: [
        {
          id: "override-a",
          workspaceId: "workspace-1",
          artifactId: "artifact-a",
          scope: "metadata",
          field: "partNumber",
          value: "A-100",
          provenance: "human",
          createdByUserId: "user-1",
          createdAt: "2026-03-29T11:10:00.000Z",
        },
        {
          id: "override-dangling",
          workspaceId: "workspace-1",
          artifactId: "artifact-missing",
          scope: "quote",
          field: "leadTimeDays",
          value: "10",
          provenance: "human",
          createdByUserId: "user-1",
          createdAt: "2026-03-29T11:11:00.000Z",
        },
        {
          id: "override-other-workspace",
          workspaceId: "workspace-2",
          artifactId: "artifact-a",
          scope: "metadata",
          field: "partNumber",
          value: "A-999",
          provenance: "system",
          createdByUserId: null,
          createdAt: "2026-03-29T11:12:00.000Z",
        },
      ],
    });

    expect(snapshot.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-a", "artifact-b"]);
    expect(snapshot.reviews.map((review) => review.id)).toEqual(["review-a"]);
    expect(snapshot.overrides.map((override) => override.id)).toEqual(["override-a"]);
  });
});
