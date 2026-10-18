import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";

export type UploadFileGroup = {
  /** Unique within one grouping. Equals normalizedStem unless a second CAD file or an empty stem needs its own key. */
  key: string;
  /** The server stem (public.normalize_file_basename) of the file that opened the group. Empty when no a-z0-9 survives. */
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

export function isDrawingUploadFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".pdf");
}

/**
 * Groups staged files into the sets that become one job each. The stem decides which drawing
 * pairs with which CAD file, with two limits that follow from the server keeping one part per
 * distinct normalized_name per job:
 * - a group holds at most one CAD file. A second CAD file with the same stem opens its own group,
 *   and a drawing of that stem pairs with the first staged CAD file;
 * - a file whose stem is empty (no a-z or 0-9 in the name) pairs with nothing and stays in its own
 *   group, keyed by its original name.
 */
export function groupUploadFiles(files: File[]): UploadFileGroup[] {
  const groups: UploadFileGroup[] = [];
  const keys = new Set<string>();
  const groupsByStem = new Map<string, UploadFileGroup[]>();

  const uniqueKey = (base: string) => {
    let key = base;
    for (let suffix = 2; keys.has(key); suffix += 1) {
      key = `${base}#${suffix}`;
    }
    keys.add(key);
    return key;
  };

  const openGroup = (file: File, normalizedStem: string, keyBase: string) => {
    const group: UploadFileGroup = {
      key: uniqueKey(keyBase),
      normalizedStem,
      displayStem: file.name.replace(/\.[^.]+$/, ""),
      files: [],
      hasCad: false,
      hasDrawing: false,
    };
    groups.push(group);
    return group;
  };

  files.forEach((file) => {
    const normalizedStem = normalizeUploadStem(file.name);
    const isCad = isCadUploadFile(file.name);
    let target: UploadFileGroup | undefined;

    if (normalizedStem === "") {
      target = openGroup(file, normalizedStem, `empty:${file.name.trim().toLowerCase()}`);
    } else {
      const sameStem = groupsByStem.get(normalizedStem) ?? [];
      // A CAD file takes a group that has none yet (a drawing staged first). Anything else joins the
      // first CAD group of its stem, or the one CAD-less group of that stem.
      target = isCad ? sameStem.find((group) => !group.hasCad) : (sameStem.find((group) => group.hasCad) ?? sameStem[0]);
      if (!target) {
        target = openGroup(file, normalizedStem, normalizedStem);
        sameStem.push(target);
        groupsByStem.set(normalizedStem, sameStem);
      }
    }

    target.files.push(file);
    target.hasCad ||= isCad;
    target.hasDrawing ||= isDrawingUploadFile(file.name);
  });

  return groups.sort((left, right) => left.displayStem.localeCompare(right.displayStem));
}

export type UnpairedUploadFiles = {
  drawingsWithoutPart: string[];
  partsWithoutDrawing: string[];
  /** Parts that share a stem with a part that already carries the drawing; a drawing pairs with one part only. */
  partsSharingPairedName: string[];
};

/**
 * Names the staged drawings with no part of the same stem and, once at least one drawing is
 * staged, the parts with no drawing. A selection of parts alone is a normal upload and reports
 * nothing. Files whose names reduce to an empty stem never pair, so they are reported as unpaired.
 */
export function findUnpairedUploadFiles(files: File[]): UnpairedUploadFiles {
  const groups = groupUploadFiles(files);
  const hasAnyDrawing = groups.some((group) => group.hasDrawing);
  const pairedStems = new Set(
    groups.filter((group) => group.hasCad && group.hasDrawing && group.normalizedStem !== "").map((group) => group.normalizedStem),
  );
  const namesIn = (group: UploadFileGroup, include: (name: string) => boolean) =>
    group.files.map((file) => file.name).filter(include);
  const cadGroupsWithoutDrawing = hasAnyDrawing ? groups.filter((group) => group.hasCad && !group.hasDrawing) : [];
  const sharesPairedName = (group: UploadFileGroup) => pairedStems.has(group.normalizedStem);

  return {
    drawingsWithoutPart: groups
      .filter((group) => group.hasDrawing && !group.hasCad)
      .flatMap((group) => namesIn(group, isDrawingUploadFile)),
    partsWithoutDrawing: cadGroupsWithoutDrawing
      .filter((group) => !sharesPairedName(group))
      .flatMap((group) => namesIn(group, isCadUploadFile)),
    partsSharingPairedName: cadGroupsWithoutDrawing
      .filter(sharesPairedName)
      .flatMap((group) => namesIn(group, isCadUploadFile)),
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
