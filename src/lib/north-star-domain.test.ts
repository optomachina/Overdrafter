import { describe, expect, it } from "vitest";
import {
  createWorkspaceDomainSnapshot,
  isArtifactRecord,
  sortArtifactsDeterministically,
  type NorthStarArtifactRecord,
} from "@/lib/north-star-domain";

describe("north-star-domain", () => {
  it("validates artifact shape", () => {
    expect(
      isArtifactRecord({
        id: "artifact-1",
        workspaceId: "workspace-1",
        sourcePath: "assembly/bracket.step",
        kind: "step",
      }),
    ).toBe(true);

    expect(
      isArtifactRecord({
        id: "artifact-1",
        workspaceId: "workspace-1",
        sourcePath: "assembly/bracket.step",
        kind: "anything",
      }),
    ).toBe(false);
  });

  it("sorts artifacts deterministically by path + kind + id", () => {
    const artifacts: NorthStarArtifactRecord[] = [
      { id: "b", workspaceId: "workspace-1", sourcePath: "z/part.step", kind: "step" },
      { id: "a", workspaceId: "workspace-1", sourcePath: "a/part.step", kind: "step" },
      { id: "c", workspaceId: "workspace-1", sourcePath: "a/part.step", kind: "pdf" },
    ];

    expect(sortArtifactsDeterministically(artifacts).map((artifact) => artifact.id)).toEqual(["c", "a", "b"]);
  });

  it("filters dangling review and override references", () => {
    const snapshot = createWorkspaceDomainSnapshot({
      workspaceId: "workspace-1",
      artifacts: [{ id: "artifact-1", workspaceId: "workspace-1", sourcePath: "part.step", kind: "step" }],
      reviews: [
        { id: "review-1", artifactId: "artifact-1", status: "pending" },
        { id: "review-2", artifactId: "artifact-missing", status: "pending" },
      ],
      overrides: [
        { id: "override-1", artifactId: "artifact-1", field: "material", value: "6061" },
        { id: "override-2", artifactId: "artifact-missing", field: "material", value: "5052" },
      ],
    });

    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.overrides).toHaveLength(1);
  });
});
