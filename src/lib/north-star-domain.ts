export type NorthStarArtifactKind = "step" | "pdf" | "bundle" | "unknown";

export interface NorthStarArtifactRecord {
  id: string;
  workspaceId: string;
  sourcePath: string;
  kind: NorthStarArtifactKind;
}

export interface NorthStarReviewRecord {
  id: string;
  artifactId: string;
  status: "pending" | "accepted" | "needs_changes";
}

export interface NorthStarOverrideRecord {
  id: string;
  artifactId: string;
  field: string;
  value: string;
}

export interface NorthStarWorkspaceDomainSnapshot {
  workspaceId: string;
  artifacts: NorthStarArtifactRecord[];
  reviews: NorthStarReviewRecord[];
  overrides: NorthStarOverrideRecord[];
}

export function isArtifactRecord(value: unknown): value is NorthStarArtifactRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<NorthStarArtifactRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.sourcePath === "string" &&
    (record.kind === "step" || record.kind === "pdf" || record.kind === "bundle" || record.kind === "unknown")
  );
}

export function sortArtifactsDeterministically(
  artifacts: readonly NorthStarArtifactRecord[],
): NorthStarArtifactRecord[] {
  return [...artifacts].sort((a, b) => {
    if (a.sourcePath !== b.sourcePath) {
      return a.sourcePath.localeCompare(b.sourcePath);
    }

    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }

    return a.id.localeCompare(b.id);
  });
}

interface CreateWorkspaceDomainSnapshotInput {
  workspaceId: string;
  artifacts: readonly NorthStarArtifactRecord[];
  reviews: readonly NorthStarReviewRecord[];
  overrides: readonly NorthStarOverrideRecord[];
}

export function createWorkspaceDomainSnapshot(
  input: CreateWorkspaceDomainSnapshotInput,
): NorthStarWorkspaceDomainSnapshot {
  const artifacts = sortArtifactsDeterministically(input.artifacts);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));

  return {
    workspaceId: input.workspaceId,
    artifacts,
    reviews: input.reviews.filter((review) => artifactIds.has(review.artifactId)),
    overrides: input.overrides.filter((override) => artifactIds.has(override.artifactId)),
  };
}
