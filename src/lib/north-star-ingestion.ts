export type NorthStarUploadKind = "step" | "pdf" | "zip" | "folder" | "unknown";

export interface NorthStarUploadCandidate {
  id: string;
  path: string;
  kind: NorthStarUploadKind;
}

export interface NorthStarIngestionArtifact {
  artifactId: string;
  stem: string;
  stepUploadId: string | null;
  drawingUploadId: string | null;
  sourceUploadIds: string[];
}

export interface NorthStarIngestionSnapshot {
  artifacts: NorthStarIngestionArtifact[];
  unmatchedUploadIds: string[];
}

function normalizeStem(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension.trim().toLowerCase();
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return a.localeCompare(b);
}

function compareArtifacts(a: NorthStarIngestionArtifact, b: NorthStarIngestionArtifact): number {
  return (
    a.stem.localeCompare(b.stem) ||
    compareNullable(a.stepUploadId, b.stepUploadId) ||
    compareNullable(a.drawingUploadId, b.drawingUploadId) ||
    a.artifactId.localeCompare(b.artifactId)
  );
}

export function createNorthStarIngestionSnapshot(
  candidates: readonly NorthStarUploadCandidate[],
): NorthStarIngestionSnapshot {
  const usable = candidates.filter((candidate) => candidate.kind === "step" || candidate.kind === "pdf");
  const byStem = new Map<
    string,
    {
      steps: NorthStarUploadCandidate[];
      pdfs: NorthStarUploadCandidate[];
    }
  >();

  for (const candidate of usable) {
    const stem = normalizeStem(candidate.path);
    const current = byStem.get(stem) ?? { steps: [], pdfs: [] };

    if (candidate.kind === "step") {
      current.steps.push(candidate);
    } else {
      current.pdfs.push(candidate);
    }

    byStem.set(stem, current);
  }

  const artifacts: NorthStarIngestionArtifact[] = [];

  for (const [stem, group] of byStem) {
    group.steps.sort((a, b) => a.id.localeCompare(b.id));
    group.pdfs.sort((a, b) => a.id.localeCompare(b.id));

    const pairCount = Math.max(group.steps.length, group.pdfs.length);

    for (let index = 0; index < pairCount; index += 1) {
      const step = group.steps[index] ?? null;
      const pdf = group.pdfs[index] ?? null;
      const artifactId = `artifact_${stem}_${String(index + 1).padStart(2, "0")}`;
      const sourceUploadIds = [step?.id, pdf?.id].filter((id): id is string => Boolean(id));

      artifacts.push({
        artifactId,
        stem,
        stepUploadId: step?.id ?? null,
        drawingUploadId: pdf?.id ?? null,
        sourceUploadIds,
      });
    }
  }

  artifacts.sort(compareArtifacts);

  const matchedIds = new Set(artifacts.flatMap((artifact) => artifact.sourceUploadIds));
  const unmatchedUploadIds = candidates
    .filter((candidate) => !matchedIds.has(candidate.id))
    .map((candidate) => candidate.id)
    .sort((a, b) => a.localeCompare(b));

  return {
    artifacts,
    unmatchedUploadIds,
  };
}
