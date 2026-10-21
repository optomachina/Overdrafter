import { geometryIssuesInRegion, type PageVectorGeometry } from "./pdfVectorGeometry.js";
import type { ExtractedFieldSignal } from "./pdfDrawing.js";
import { currentRevisionReads, isPlaceholderOrLabelValue, type CellRead } from "./titleBlockCells.js";

const CELL_FIELDS = new Set(["partNumber", "revision", "material", "finish"]);
const comparable = (value: string | null) => value?.replace(/\s+/g, " ").trim().toUpperCase() ?? null;

type ApprovalInput = {
  titleBlockApprovalEnabled?: boolean;
  fields: Record<string, ExtractedFieldSignal>;
  /** Immutable deterministic verdicts, captured before model merging. */
  deterministicFields?: Record<string, ExtractedFieldSignal>;
  /** Fields actually read from title-block cells or label anchors, including layout fallbacks. */
  titleBlockFields?: readonly string[];
  cellProof?: { geometryByPage: ReadonlyMap<number, PageVectorGeometry | undefined>; reads: readonly CellRead[]; independentReads: readonly CellRead[]; independentComplete: boolean; drawingProven: boolean };
  tolerance?: { valueInch: number | null; independentValueInch: number | null; independentUnresolved?: boolean; drawingProven: boolean; titleBlockProof?: boolean };
};

/**
 * The only final approval decision, called after parser rescues and again after model merging.
 * Suggestions/confidence never create proof. Every veto is monotonic, including unread geometry,
 * ambiguous revision roles, independent contradictions and placeholder/label values.
 */
export function finalizeExtractionApproval(input: ApprovalInput): { toleranceApproved: boolean; toleranceProven: boolean; toleranceApprovalDisabled: boolean } {
  const reads = currentRevisionReads(input.cellProof?.reads ?? []);
  const independentReads = currentRevisionReads(input.cellProof?.independentReads ?? []);
  const frames = [...(input.cellProof?.geometryByPage.entries() ?? [])].filter(([, geometry]) =>
    geometry?.issues.some((issue) => issue.cause === "coordinate_frame_mismatch"));
  for (const [name, field] of Object.entries(input.fields)) {
    const reasons = new Set(field.reasons);
    const hasTitleBlockEvidence = input.titleBlockFields?.includes(name) ||
      reads.some((read) => read.field === name) || reasons.has("title_block_cell_proven") || reasons.has("ocr_title_block");
    let reviewNeeded = field.reviewNeeded;
    if (frames.some(([page]) => !field.sourceRegion || field.sourceRegion.page === page)) {
      reviewNeeded = true;
      reasons.add("geometry_coordinate_frame_mismatch");
    }
    const deterministic = input.deterministicFields?.[name];
    if (deterministic) {
      reviewNeeded ||= deterministic.reviewNeeded;
      if (deterministic.reviewNeeded) for (const reason of deterministic.reasons) reasons.add(reason);
      if (comparable(deterministic.value) !== comparable(field.value)) {
        reviewNeeded = true;
        reasons.add("model_value_unproven");
      }
    }
    if (field.value && isPlaceholderOrLabelValue(field.value)) {
      reviewNeeded = true;
      reasons.add("rejected_label_token");
    }
    if (input.cellProof && CELL_FIELDS.has(name) && hasTitleBlockEvidence) {
      const cells = reads.filter((read) => read.field === name);
      const agrees = (read: CellRead) => read.status === "value" && read.complete &&
        comparable(read.value) === comparable(field.value) &&
        (name !== "revision" || read.revisionRole === "current");
      // I7: approval requires a positive complete vector scan for every participating region.
      const geometryIssues = cells.flatMap((read) => geometryIssuesInRegion(
        input.cellProof!.geometryByPage.get(read.page), read.geometryRegion));
      const geometryProven = geometryIssues.length === 0;
      if (!geometryProven) {
        reviewNeeded = true;
        reasons.add("title_block_geometry_incomplete");
        for (const cause of geometryIssues) reasons.add(`geometry_${cause}`);
      }
      const proven = geometryProven && input.cellProof.drawingProven && input.cellProof.independentComplete && cells.some(agrees) &&
        cells.every((read) => (read.status === "empty" && read.complete) || agrees(read));
      const conflict = independentReads.some((read) => read.field === name &&
        [read.value, ...(read.observations ?? []).filter((observation) => observation.binding === "label_owned")
          .map((observation) => observation.value)].some((value) => value !== null && comparable(value) !== comparable(field.value)));
      reviewNeeded ||= !proven || conflict;
      let proofReason = "title_block_page_unread";
      if (proven) proofReason = "title_block_cell_proven";
      else if (input.cellProof.drawingProven) proofReason = "title_block_cell_unread";
      reasons.add(proofReason);
      if (conflict) reasons.add("independent_source_conflict");
      if (!input.cellProof.independentComplete) reasons.add("independent_source_unread");
    }
    // Apply after all proof paths, including deterministic evidence carried through model merging.
    if (!input.titleBlockApprovalEnabled && hasTitleBlockEvidence) {
      reviewNeeded = true;
      reasons.add("title_block_approval_disabled");
    }
    input.fields[name] = { ...field, reviewNeeded, reasons: [...reasons] };
  }
  const tolerance = input.tolerance;
  const toleranceApprovalDisabled = !input.titleBlockApprovalEnabled && tolerance?.titleBlockProof === true;
  const toleranceProven = Boolean(tolerance?.drawingProven && !tolerance.independentUnresolved && tolerance.valueInch !== null &&
    (tolerance.independentValueInch === null || tolerance.independentValueInch >= tolerance.valueInch));
  return { toleranceProven, toleranceApprovalDisabled, toleranceApproved: !toleranceApprovalDisabled && toleranceProven };
}
