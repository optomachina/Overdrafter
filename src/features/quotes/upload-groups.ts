import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";

export type UploadFileGroup = {
  normalizedStem: string;
  displayStem: string;
  files: File[];
  hasCad: boolean;
  hasDrawing: boolean;
};

const CAD_EXTENSIONS = new Set([
  "step",
  "stp",
  "iges",
  "igs",
  "sldprt",
  "prt",
  "sldasm",
  "asm",
  "x_t",
  "xt",
]);

/**
 * Must return exactly what public.normalize_file_basename returns: strip the last extension,
 * lowercase, turn each run of characters outside a-z0-9 into one "-", trim "-" from both ends.
 * upload-stem-fixtures.json holds the shared cases. U+0130 is lowercased to "i" by a UTF-8
 * database but to "i" plus a combining dot by JavaScript, so it is mapped first.
 */
export function normalizeUploadStem(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\u{130}/gu, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isCadUploadFile(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CAD_EXTENSIONS.has(extension);
}

export function groupUploadFiles(files: File[]): UploadFileGroup[] {
  const groups = new Map<string, UploadFileGroup>();

  files.forEach((file) => {
    const normalizedStem = normalizeUploadStem(file.name);
    const existing =
      groups.get(normalizedStem) ??
      {
        normalizedStem,
        displayStem: file.name.replace(/\.[^.]+$/, ""),
        files: [],
        hasCad: false,
        hasDrawing: false,
      };

    existing.files.push(file);
    existing.hasCad ||= isCadUploadFile(file.name);
    existing.hasDrawing ||= file.name.toLowerCase().endsWith(".pdf");

    groups.set(normalizedStem, existing);
  });

  return [...groups.values()].sort((left, right) => left.displayStem.localeCompare(right.displayStem));
}

export type UnpairedUploadFiles = {
  drawingsWithoutPart: string[];
  partsWithoutDrawing: string[];
};

/**
 * Names the staged drawings with no part of the same stem and, once at least one drawing is
 * staged, the parts with no drawing of the same stem. A selection of parts alone is a normal
 * upload and reports nothing.
 */
export function findUnpairedUploadFiles(files: File[]): UnpairedUploadFiles {
  const groups = groupUploadFiles(files);
  const hasAnyDrawing = groups.some((group) => group.hasDrawing);
  const namesIn = (group: UploadFileGroup, include: (name: string) => boolean) =>
    group.files.map((file) => file.name).filter(include);
  const isDrawing = (name: string) => name.toLowerCase().endsWith(".pdf");

  return {
    drawingsWithoutPart: groups
      .filter((group) => group.hasDrawing && !group.hasCad)
      .flatMap((group) => namesIn(group, isDrawing)),
    partsWithoutDrawing: hasAnyDrawing
      ? groups
          .filter((group) => group.hasCad && !group.hasDrawing)
          .flatMap((group) => namesIn(group, isCadUploadFile))
      : [],
  };
}

export function buildProjectNameFromLabels(labels: string[]): string {
  const normalizedLabels = labels
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  if (normalizedLabels.length === 0) {
    return "New project";
  }

  if (normalizedLabels.length === 1) {
    return normalizedLabels[0]!.slice(0, 120);
  }

  return `${normalizedLabels[0]!.slice(0, 120)} + ${normalizedLabels.length - 1} parts`;
}

export function buildAutoProjectName(_prompt: string, groups: UploadFileGroup[]): string {
  return buildProjectNameFromLabels(
    groups.map((group) => (group.files.length === 1 ? buildDraftTitleFromPrompt("", group.files) : group.displayStem)),
  );
}
