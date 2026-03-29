import type { DeterministicArtifactPair } from "@/lib/north-star-ingestion";

export type InferredWorkspaceComposition = "assembly" | "loose_parts";

export interface AssemblyInferenceResult {
  composition: InferredWorkspaceComposition;
  viewportTargetArtifactId: string | null;
  reasons: string[];
}

function looksLikeAssembly(stem: string): boolean {
  return /assembly|assy|asm/i.test(stem);
}

export function inferWorkspaceComposition(
  pairs: readonly DeterministicArtifactPair[],
): AssemblyInferenceResult {
  if (pairs.length === 0) {
    return {
      composition: "loose_parts",
      viewportTargetArtifactId: null,
      reasons: ["no_artifacts"],
    };
  }

  const assemblyCandidate = pairs.find((pair) => looksLikeAssembly(pair.stem));
  if (assemblyCandidate) {
    return {
      composition: "assembly",
      viewportTargetArtifactId: assemblyCandidate.artifactId,
      reasons: ["stem_matches_assembly_pattern"],
    };
  }

  const highestCompleteness = [...pairs].sort((a, b) => {
    const aScore = Number(Boolean(a.stepPath)) + Number(Boolean(a.pdfPath));
    const bScore = Number(Boolean(b.stepPath)) + Number(Boolean(b.pdfPath));

    if (aScore !== bScore) {
      return bScore - aScore;
    }

    return a.stem.localeCompare(b.stem);
  })[0];

  return {
    composition: "loose_parts",
    viewportTargetArtifactId: highestCompleteness?.artifactId ?? null,
    reasons: ["default_loose_parts_by_density"],
  };
}
