/**
 * Client flag for the single Quantity field in the part request editor (OVD-997, slice P1 of OVD-987).
 * Default off: with the flag off the editor keeps its Qty and Quote quantities fields exactly as before.
 * The flag only turns the new field on. Whether a quantity above 1 can be entered is decided by the
 * server (see quantity-scope.ts), and the server still refuses any quantity it has not scoped.
 */
export function isControlledBetaSingleQuantityEnabled(
  value: string | undefined = import.meta.env.VITE_CONTROLLED_BETA_SINGLE_QUANTITY,
): boolean {
  return value === "1";
}
