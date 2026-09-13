/** Compare exact evidence strings by UTF-16 code units, independently of the
 * host locale. This preserves canonical wire/path ordering and duplicates. */
export function compareEvidenceText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
