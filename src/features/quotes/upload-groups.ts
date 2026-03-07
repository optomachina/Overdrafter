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

export function normalizeUploadStem(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLowerCase();
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
