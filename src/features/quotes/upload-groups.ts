import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";

export type UploadFileGroup = {
  /** Trimmed, lower-cased original stem of the file that opened the group (not the server stem). */
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
 * The distinct non-empty server stems of the group's files that pass `include`. Files that share an
 * original stem usually share a server stem too, but U+0130 and its lower-cased form do not (the
 * server maps one to "i" and the other to "i-"), so a group can hold several; reading only the first
 * file would make pairing depend on staging order.
 */
function serverStemsOf(group: UploadFileGroup, include: (name: string) => boolean): string[] {
  const stems = new Set<string>();
  for (const file of group.files) {
    const stem = include(file.name) ? normalizeUploadStem(file.name) : "";
    if (stem !== "") {
      stems.add(stem);
    }
  }
  return [...stems];
}

/**
 * Joins each group that holds a drawing and no CAD file to the CAD-bearing group whose server stem
 * is equal and not empty, but only while that CAD group has no drawing yet. The server keeps one
 * drawing per part (the last one uploaded, and a group uploads in file order), so a second drawing
 * merged behind a drawing the part already has would displace it. Such a drawing, and any further
 * drawing-only group, stays separate and is reported as unpaired. With several CAD groups of one
 * server stem the first staged one is the target: pairing follows the server's own rule, which cannot
 * tell them apart. A group with CAD is never absorbed or merged.
 */
function mergeDrawingOnlyGroups(groups: UploadFileGroup[]): UploadFileGroup[] {
  const cadGroupByServerStem = new Map<string, UploadFileGroup>();
  for (const group of groups) {
    if (!group.hasCad) {
      continue;
    }
    for (const serverStem of serverStemsOf(group, isCadUploadFile)) {
      if (!cadGroupByServerStem.has(serverStem)) {
        cadGroupByServerStem.set(serverStem, group);
      }
    }
  }

  return groups.filter((group) => {
    if (group.hasCad || !group.hasDrawing) {
      return true;
    }
    const candidates = serverStemsOf(group, isDrawingUploadFile).flatMap((serverStem) => {
      const candidate = cadGroupByServerStem.get(serverStem);
      return candidate ? [candidate] : [];
    });
    const target = candidates.sort((left, right) => groups.indexOf(left) - groups.indexOf(right))[0];
    if (!target || target.hasDrawing) {
      return true;
    }
    target.files.push(...group.files);
    target.hasDrawing = true;
    return false;
  });
}

/**
 * Groups staged files into the sets that become one job each.
 *
 * 1. Files group by their trimmed, lower-cased original stem, exactly as before OVD-980: identical
 *    stems share a group (a.step, a.stp and a.pdf are one group), different stems never do. A drawing
 *    whose own name matches a CAD file therefore always stays with that file.
 * 2. A group that holds a drawing and no CAD file then joins the CAD-bearing group whose server stem
 *    (normalizeUploadStem) is equal and not empty, because the server pairs a drawing to a CAD file by
 *    that stem. Names with no a-z or 0-9 never pair across different names. It joins only a group that
 *    has no drawing yet, so a drawing the part already has is never displaced.
 */
export function groupUploadFiles(files: File[]): UploadFileGroup[] {
  const groups = new Map<string, UploadFileGroup>();

  files.forEach((file) => {
    const normalizedStem = file.name.replace(/\.[^.]+$/, "").trim().toLowerCase();
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
    existing.hasDrawing ||= isDrawingUploadFile(file.name);

    groups.set(normalizedStem, existing);
  });

  return mergeDrawingOnlyGroups([...groups.values()]).sort((left, right) =>
    left.displayStem.localeCompare(right.displayStem),
  );
}

export type UnpairedUploadFiles = {
  drawingsWithoutPart: string[];
  partsWithoutDrawing: string[];
  /** Parts whose server name equals that of a part that already carries the drawing; a drawing pairs with one part only. */
  partsSharingPairedName: string[];
};

/**
 * Names the staged drawings with no part of the same name and, once at least one drawing is staged,
 * the parts with no drawing. A selection of parts alone is a normal upload and reports nothing. A part
 * whose server name equals that of a part that has the drawing is reported apart, because the drawing
 * can go to only one of them.
 */
export function findUnpairedUploadFiles(files: File[]): UnpairedUploadFiles {
  const groups = groupUploadFiles(files);
  const hasAnyDrawing = groups.some((group) => group.hasDrawing);
  const pairedServerStems = new Set(
    groups.filter((group) => group.hasCad && group.hasDrawing).flatMap((group) => serverStemsOf(group, isCadUploadFile)),
  );
  const namesIn = (group: UploadFileGroup, include: (name: string) => boolean) =>
    group.files.map((file) => file.name).filter(include);
  const cadGroupsWithoutDrawing = hasAnyDrawing ? groups.filter((group) => group.hasCad && !group.hasDrawing) : [];
  const sharesPairedName = (group: UploadFileGroup) =>
    serverStemsOf(group, isCadUploadFile).some((serverStem) => pairedServerStems.has(serverStem));

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
