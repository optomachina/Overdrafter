import { describe, expect, it } from "vitest";
import {
  createWorkspaceDomainSnapshot,
  isArtifactRecord,
  sortArtifactsDeterministically,
  type ArtifactRecord,
} from "@/lib/north-star-domain";

describe("north-star-domain", () => {
  it("validates artifact records", () => {
    expect(
      isArtifactRecord({
        id: "artifact-1",
        workspaceId: "ws-1",
        filename: "part.step",
        kind: "step",
        createdAt: "2026-03-29T00:00:00.000Z",
      }),
    ).toBe(true);

    expect(isArtifactRecord({ id: "missing-fields" })).toBe(false);
  });

  it("sorts artifacts deterministically by filename then id", () => {
    const artifacts: ArtifactRecord[] = [
      {
        id: "artifact-2",
        workspaceId: "ws-1",
        filename: "B.step",
        kind: "step",
        createdAt: "2026-03-29T00:00:00.000Z",
      },
      {
        id: "artifact-1",
        workspaceId: "ws-1",
        filename: "A.step",
        kind: "step",
        createdAt: "2026-03-29T00:00:00.000Z",
      },
    ];

    expect(sortArtifactsDeterministically(artifacts).map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
    ]);
  });

  it("drops dangling override and review references from snapshots", () => {
    const snapshot = createWorkspaceDomainSnapshot({
      workspaceId: "ws-1",
      artifacts: [
        {
          id: "artifact-1",
          workspaceId: "ws-1",
          filename: "A.step",
          kind: "step",
          createdAt: "2026-03-29T00:00:00.000Z",
        },
      ],
      overrides: [
        { id: "override-1", artifactId: "artifact-1", field: "material", value: "6061" },
        { id: "override-2", artifactId: "artifact-missing", field: "material", value: "7075" },
      ],
      reviews: [
        { id: "review-1", artifactId: "artifact-1", status: "approved" },
        { id: "review-2", artifactId: "artifact-missing", status: "pending" },
      ],
    });

    expect(snapshot.overrides).toEqual([
      { id: "override-1", artifactId: "artifact-1", field: "material", value: "6061" },
    ]);
    expect(snapshot.reviews).toEqual([{ id: "review-1", artifactId: "artifact-1", status: "approved" }]);
  });
});
