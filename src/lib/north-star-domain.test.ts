import { describe, expect, it } from "vitest";
import {
  createWorkspaceDomainSnapshot,
  isArtifactRecord,
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
  });
});

describe("sortArtifactsDeterministically", () => {
  it("sorts artifacts by digest, filename, and id", () => {
    const sorted = sortArtifactsDeterministically([ARTIFACT_B, ARTIFACT_A]);
    expect(sorted.map((artifact) => artifact.id)).toEqual(["artifact-a", "artifact-b"]);
  });
});

describe("createWorkspaceDomainSnapshot", () => {
  it("drops dangling review and override records that reference unknown artifacts", () => {
    const snapshot = createWorkspaceDomainSnapshot({
      workspaceId: "workspace-1",
      artifacts: [ARTIFACT_B, ARTIFACT_A],
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
      ],
    });

    expect(snapshot.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-a", "artifact-b"]);
    expect(snapshot.reviews.map((review) => review.id)).toEqual(["review-a"]);
    expect(snapshot.overrides.map((override) => override.id)).toEqual(["override-a"]);
  });
});
