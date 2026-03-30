export type ArtifactKind = "cad" | "drawing" | "document" | "image" | "other";
export type ArtifactRole = "primary_model" | "supporting_model" | "drawing" | "spec" | "note";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type OverrideScope = "metadata" | "dfm" | "quote";
export type OverrideProvenance = "system" | "human";

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
  provenance: OverrideProvenance;
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

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

const ARTIFACT_KINDS: readonly ArtifactKind[] = ["cad", "drawing", "document", "image", "other"];
const ARTIFACT_ROLES: readonly ArtifactRole[] = [
  "primary_model",
  "supporting_model",
  "drawing",
  "spec",
  "note",
];
const REVIEW_STATUSES: readonly ReviewStatus[] = ["pending", "approved", "rejected"];
const OVERRIDE_SCOPES: readonly OverrideScope[] = ["metadata", "dfm", "quote"];
const OVERRIDE_PROVENANCES: readonly OverrideProvenance[] = ["system", "human"];

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
    isOneOf(candidate.kind, ARTIFACT_KINDS) &&
    isOneOf(candidate.role, ARTIFACT_ROLES) &&
    hasText(candidate.sourcePath) &&
    hasText(candidate.createdAt)
  );
}

export function isReviewRecord(value: unknown): value is ReviewRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ReviewRecord>;
  return (
    hasText(candidate.id) &&
    hasText(candidate.workspaceId) &&
    hasText(candidate.artifactId) &&
    isOneOf(candidate.status, REVIEW_STATUSES) &&
    (candidate.reviewerUserId === null || hasText(candidate.reviewerUserId)) &&
    (candidate.rationale === null || hasText(candidate.rationale)) &&
    (candidate.reviewedAt === null || hasText(candidate.reviewedAt))
  );
}

export function isOverrideRecord(value: unknown): value is OverrideRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<OverrideRecord>;
  return (
    hasText(candidate.id) &&
    hasText(candidate.workspaceId) &&
    hasText(candidate.artifactId) &&
    isOneOf(candidate.scope, OVERRIDE_SCOPES) &&
    hasText(candidate.field) &&
    typeof candidate.value === "string" &&
    isOneOf(candidate.provenance, OVERRIDE_PROVENANCES) &&
    (candidate.createdByUserId === null || hasText(candidate.createdByUserId)) &&
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
  const artifacts = sortArtifactsDeterministically(
    input.artifacts.filter(
      (artifact) => isArtifactRecord(artifact) && artifact.workspaceId === input.workspaceId,
    ),
  );

  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const reviews = input.reviews.filter(
    (review) =>
      isReviewRecord(review) &&
      review.workspaceId === input.workspaceId &&
      artifactIds.has(review.artifactId),
  );
  const overrides = input.overrides.filter(
    (override) =>
      isOverrideRecord(override) &&
      override.workspaceId === input.workspaceId &&
      artifactIds.has(override.artifactId),
  );

  return {
    workspaceId: input.workspaceId,
    artifacts,
    reviews: [...reviews].sort(
      (a, b) =>
        a.artifactId.localeCompare(b.artifactId) ||
        (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? "") ||
        a.id.localeCompare(b.id),
    ),
    overrides: [...overrides].sort(
      (a, b) =>
        a.artifactId.localeCompare(b.artifactId) ||
        a.field.localeCompare(b.field) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    ),
  };
}
