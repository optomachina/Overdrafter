export interface UploadedArtifactInput {
  path: string;
  source: "file" | "folder" | "zip";
}

export interface IngestedArtifactPair {
  artifactId: string;
  stem: string;
  stepPath: string | null;
  pdfPath: string | null;
}

export interface IngestionUnmatched {
  unsupported: UploadedArtifactInput[];
  unpairedStepPaths: string[];
  unpairedPdfPaths: string[];
}

export interface IngestionResult {
  artifacts: IngestedArtifactPair[];
  unmatched: IngestionUnmatched;
}

function extname(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 ? path.slice(lastDot + 1).toLowerCase() : "";
}

function stem(path: string): string {
  const filename = path.split("/").pop() ?? path;
  const lastDot = filename.lastIndexOf(".");
  return (lastDot >= 0 ? filename.slice(0, lastDot) : filename).trim().toLowerCase();
}

function stableArtifactId(seed: string): string {
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return `artifact_${hash.toString(36).padStart(7, "0")}`;
}

export function createDeterministicIngestionArtifacts(inputs: UploadedArtifactInput[]): IngestionResult {
  const stepByStem = new Map<string, string[]>();
  const pdfByStem = new Map<string, string[]>();
  const unsupported: UploadedArtifactInput[] = [];

  for (const input of inputs) {
    const extension = extname(input.path);

    if (extension === "step" || extension === "stp") {
      const key = stem(input.path);
      const entries = stepByStem.get(key) ?? [];
      entries.push(input.path);
      stepByStem.set(key, entries);
      continue;
    }

    if (extension === "pdf") {
      const key = stem(input.path);
      const entries = pdfByStem.get(key) ?? [];
      entries.push(input.path);
      pdfByStem.set(key, entries);
      continue;
    }

    unsupported.push(input);
  }

  const allStems = Array.from(new Set([...stepByStem.keys(), ...pdfByStem.keys()])).sort((a, b) => a.localeCompare(b));

  const artifacts: IngestedArtifactPair[] = [];
  const unpairedStepPaths: string[] = [];
  const unpairedPdfPaths: string[] = [];

  for (const key of allStems) {
    const stepPaths = [...(stepByStem.get(key) ?? [])].sort((a, b) => a.localeCompare(b));
    const pdfPaths = [...(pdfByStem.get(key) ?? [])].sort((a, b) => a.localeCompare(b));
    const pairCount = Math.max(stepPaths.length, pdfPaths.length);

    for (let index = 0; index < pairCount; index += 1) {
      const stepPath = stepPaths[index] ?? null;
      const pdfPath = pdfPaths[index] ?? null;
      const artifactSeed = `${key}:${index}:${stepPath ?? ""}:${pdfPath ?? ""}`;

      artifacts.push({
        artifactId: stableArtifactId(artifactSeed),
        stem: key,
        stepPath,
        pdfPath,
      });

      if (!pdfPath && stepPath) {
        unpairedStepPaths.push(stepPath);
      }

      if (!stepPath && pdfPath) {
        unpairedPdfPaths.push(pdfPath);
      }
    }
  }

  return {
    artifacts,
    unmatched: {
      unsupported: unsupported.sort((a, b) => a.path.localeCompare(b.path)),
      unpairedStepPaths,
      unpairedPdfPaths,
    },
  };
}
