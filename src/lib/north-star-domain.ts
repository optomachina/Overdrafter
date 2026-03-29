export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  filename: string;
  kind: "step" | "pdf" | "bundle" | "unknown";
  createdAt: string;
}

export interface ArtifactOverrideRecord {
  id: string;
  artifactId: string;
  field: string;
  value: string;
}

export interface ArtifactReviewRecord {
  id: string;
  artifactId: string;
  status: "pending" | "approved" | "rejected";
}

export interface WorkspaceDomainSnapshot {
  workspaceId: string;
  artifacts: ArtifactRecord[];
  overrides: ArtifactOverrideRecord[];
  reviews: ArtifactReviewRecord[];
}

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ArtifactRecord>;

  return Boolean(
    candidate.id &&
      candidate.workspaceId &&
      candidate.filename &&
      candidate.createdAt &&
      (candidate.kind === "step" ||
        candidate.kind === "pdf" ||
        candidate.kind === "bundle" ||
        candidate.kind === "unknown"),
  );
}

export function sortArtifactsDeterministically(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  return [...artifacts].sort((a, b) => {
    if (a.filename === b.filename) {
      return a.id.localeCompare(b.id);
    }

    return a.filename.localeCompare(b.filename);
  });
}

export function createWorkspaceDomainSnapshot(input: WorkspaceDomainSnapshot): WorkspaceDomainSnapshot {
  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.id));

  return {
    workspaceId: input.workspaceId,
    artifacts: sortArtifactsDeterministically(input.artifacts),
    overrides: input.overrides
      .filter((override) => artifactIds.has(override.artifactId))
      .sort((a, b) => a.id.localeCompare(b.id)),
    reviews: input.reviews
      .filter((review) => artifactIds.has(review.artifactId))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
