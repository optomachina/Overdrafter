export type ArtifactKind = "cad" | "drawing" | "document" | "image" | "other";
export type ArtifactRole = "primary_model" | "supporting_model" | "drawing" | "spec" | "note";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type OverrideScope = "metadata" | "dfm" | "quote";

export type ArtifactRecord = {
  id: string;
  workspaceId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  kind: ArtifactKind;
  role: ArtifactRole;
  sourcePath: string;
  createdAt: string;
};

export type ReviewRecord = {
  id: string;
  workspaceId: string;
  artifactId: string;
  status: ReviewStatus;
  reviewerUserId: string | null;
  rationale: string | null;
  reviewedAt: string | null;
};

export type OverrideRecord = {
  id: string;
  workspaceId: string;
  artifactId: string;
  scope: OverrideScope;
  field: string;
  value: string;
  provenance: "system" | "human";
  createdByUserId: string | null;
  createdAt: string;
};

export type WorkspaceDomainSnapshot = {
  workspaceId: string;
  artifacts: ArtifactRecord[];
  reviews: ReviewRecord[];
  overrides: OverrideRecord[];
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ArtifactRecord>;
  return (
    hasText(candidate.id) &&
    hasText(candidate.workspaceId) &&
    hasText(candidate.filename) &&
    hasText(candidate.mediaType) &&
    typeof candidate.sizeBytes === "number" &&
    candidate.sizeBytes >= 0 &&
    hasText(candidate.sha256) &&
    hasText(candidate.kind) &&
    hasText(candidate.role) &&
    hasText(candidate.sourcePath) &&
    hasText(candidate.createdAt)
  );
}

export function sortArtifactsDeterministically(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  return [...artifacts].sort((left, right) => {
    if (left.sha256 !== right.sha256) {
      return left.sha256.localeCompare(right.sha256);
    }

    if (left.filename !== right.filename) {
      return left.filename.localeCompare(right.filename);
    }

    return left.id.localeCompare(right.id);
  });
}

export function createWorkspaceDomainSnapshot(input: WorkspaceDomainSnapshot): WorkspaceDomainSnapshot {
  const artifacts = sortArtifactsDeterministically(input.artifacts);

  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const reviews = input.reviews.filter((review) => artifactIds.has(review.artifactId));
  const overrides = input.overrides.filter((override) => artifactIds.has(override.artifactId));

  return {
    workspaceId: input.workspaceId,
    artifacts,
    reviews: [...reviews].sort((a, b) => a.id.localeCompare(b.id)),
    overrides: [...overrides].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
