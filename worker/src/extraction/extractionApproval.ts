import type { ExtractedFieldSignal } from "./pdfDrawing.js";
import { currentRevisionReads, isPlaceholderOrLabelValue, type CellRead } from "./titleBlockCells.js";

const CELL_FIELDS = new Set(["partNumber", "revision", "material", "finish"]);
const comparable = (value: string | null) => value?.replace(/\s+/g, " ").trim().toUpperCase() ?? null;

type ApprovalInput = {
  fields: Record<string, ExtractedFieldSignal>;
  /** Immutable deterministic verdicts, captured before model merging. */
  deterministicFields?: Record<string, ExtractedFieldSignal>;
  cellProof?: { reads: readonly CellRead[]; independentReads: readonly CellRead[]; independentComplete: boolean; drawingProven: boolean };
  tolerance?: { valueInch: number | null; independentValueInch: number | null; independentUnresolved?: boolean; drawingProven: boolean };
};

/**
 * The only final approval decision, called after parser rescues and again after model merging.
 * Suggestions/confidence never create proof. Every veto is monotonic, including unread geometry,
 * ambiguous revision roles, independent contradictions and placeholder/label values.
 */
export function finalizeExtractionApproval(input: ApprovalInput): { toleranceApproved: boolean } {
  const reads = currentRevisionReads(input.cellProof?.reads ?? []);
  const independentReads = currentRevisionReads(input.cellProof?.independentReads ?? []);
  for (const [name, field] of Object.entries(input.fields)) {
    const reasons = new Set(field.reasons);
    let reviewNeeded = field.reviewNeeded;
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
    if (input.cellProof && CELL_FIELDS.has(name)) {
      const cells = reads.filter((read) => read.field === name);
      const agrees = (read: CellRead) => read.status === "value" && read.complete &&
        comparable(read.value) === comparable(field.value) &&
        (name !== "revision" || read.revisionRole === "current");
      const proven = input.cellProof.drawingProven && input.cellProof.independentComplete && cells.some(agrees) &&
        cells.every((read) => (read.status === "empty" && read.complete) || agrees(read));
      const conflict = independentReads.some((read) => read.field === name &&
        [read.value, ...(read.observations ?? []).filter((observation) => observation.binding === "label_owned")
          .map((observation) => observation.value)].some((value) => value !== null && comparable(value) !== comparable(field.value)));
      reviewNeeded ||= !proven || conflict;
      reasons.add(proven ? "title_block_cell_proven" : input.cellProof.drawingProven
        ? "title_block_cell_unread" : "title_block_page_unread");
      if (conflict) reasons.add("independent_source_conflict");
      if (!input.cellProof.independentComplete) reasons.add("independent_source_unread");
    }
    input.fields[name] = { ...field, reviewNeeded, reasons: [...reasons] };
  }
  const tolerance = input.tolerance;
  return { toleranceApproved: Boolean(tolerance?.drawingProven && !tolerance.independentUnresolved && tolerance.valueInch !== null &&
    (tolerance.independentValueInch === null || tolerance.independentValueInch >= tolerance.valueInch)) };
}
