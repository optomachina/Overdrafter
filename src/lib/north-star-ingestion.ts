export interface IngestionUpload {
  path: string;
  bytes?: number;
}

export interface DeterministicArtifactPair {
  artifactId: string;
  stem: string;
  stepPath: string | null;
  pdfPath: string | null;
}

export interface DeterministicIngestionResult {
  pairs: DeterministicArtifactPair[];
  unmatchedPaths: string[];
  unsupportedPaths: string[];
}

function normalize(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

function stemFromPath(path: string): string {
  const normalized = normalize(path);
  const filename = normalized.split("/").pop() ?? normalized;
  const lastDot = filename.lastIndexOf(".");

  if (lastDot <= 0) {
    return filename.toLowerCase();
  }

  return filename.slice(0, lastDot).toLowerCase();
}

function extensionFromPath(path: string): string {
  const normalized = normalize(path);
  const filename = normalized.split("/").pop() ?? normalized;
  const lastDot = filename.lastIndexOf(".");

  if (lastDot <= 0) {
    return "";
  }

  return filename.slice(lastDot + 1).toLowerCase();
}

function buildArtifactId(stem: string, stepPath: string | null, pdfPath: string | null): string {
  const source = `${stem}|${stepPath ?? ""}|${pdfPath ?? ""}`;
  let hash = 2166136261;

  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  const normalized = (hash >>> 0).toString(16).padStart(8, "0");
  return `artifact_${normalized}`;
}

export function createDeterministicIngestionResult(
  uploads: readonly IngestionUpload[],
): DeterministicIngestionResult {
  const stepByStem = new Map<string, string[]>();
  const pdfByStem = new Map<string, string[]>();
  const unmatchedPaths: string[] = [];
  const unsupportedPaths: string[] = [];

  for (const upload of uploads) {
    const path = normalize(upload.path);
    const ext = extensionFromPath(path);

    if (ext === "step" || ext === "stp") {
      const stem = stemFromPath(path);
      const current = stepByStem.get(stem) ?? [];
      current.push(path);
      stepByStem.set(stem, current);
      continue;
    }

    if (ext === "pdf") {
      const stem = stemFromPath(path);
      const current = pdfByStem.get(stem) ?? [];
      current.push(path);
      pdfByStem.set(stem, current);
      continue;
    }

    if (ext === "zip" || path.includes("/")) {
      unmatchedPaths.push(path);
      continue;
    }

    unsupportedPaths.push(path);
  }

  const stems = new Set<string>([...stepByStem.keys(), ...pdfByStem.keys()]);
  const pairs: DeterministicArtifactPair[] = [];

  for (const stem of [...stems].sort()) {
    const steps = (stepByStem.get(stem) ?? []).sort();
    const pdfs = (pdfByStem.get(stem) ?? []).sort();
    const pairCount = Math.max(steps.length, pdfs.length);

    for (let i = 0; i < pairCount; i += 1) {
      const stepPath = steps[i] ?? null;
      const pdfPath = pdfs[i] ?? null;
      pairs.push({
        artifactId: buildArtifactId(stem, stepPath, pdfPath),
        stem,
        stepPath,
        pdfPath,
      });
    }
  }

  return {
    pairs,
    unmatchedPaths: unmatchedPaths.sort(),
    unsupportedPaths: unsupportedPaths.sort(),
  };
}
