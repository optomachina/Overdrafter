import type {
  ProviderPortalCleanupCapability,
  ProviderPortalCleanupOutcome,
  ProviderPortalDefinition,
} from "./providerPortalKernel.js";

/**
 * OSH Cut cart cleanup (Blaine's standing rule, 2026-10-15): once the price
 * is read, or after a failure that followed upload, the uploaded part is
 * deleted from the cart on `/cart/O-<uuid>`. With no upload-correlated provider identity, cleanup requires exactly one new
 * row with the exact staged filename. Ambiguity is left for manual cleanup.
 *
 * The capture of 2026-10-15 did not open the delete control, so these
 * selectors are a reviewed guess: a remove/delete/trash control inside the
 * part row, then an in-page confirm button if one appears (a native confirm
 * is accepted by the kernel). A miss is reported as `not_found` or
 * `incomplete` in the `providerPortalCleanup` log for manual removal.
 */
export const OSHCUT_CART_ROW = ":has(> .cartInformationArea)";
export const OSHCUT_CART_FILE_NAME = ".cartInformationArea";

export const OSHCUT_CART_CLEANUP_SELECTORS = Object.freeze({
  partRow: Object.freeze({ selector: OSHCUT_CART_ROW, uploadedRows: true }),
  removePart: Object.freeze({
    scope: OSHCUT_CART_ROW,
    uploadedRows: true,
    selector: [
      "[aria-label*='remove' i]",
      "[aria-label*='delete' i]",
      "[title*='remove' i]",
      "[title*='delete' i]",
      ".fa-trash",
      ".fa-trash-alt",
      ".fa-times",
      ".deleteButton",
      ".removeButton",
    ].join(", "),
  }),
  confirmRemove: Object.freeze({
    selector: [
      "[role='dialog'] button:text-is('Delete')",
      "[role='dialog'] button:text-is('Remove')",
      "[role='dialog'] button:text-is('Yes')",
      ".Modal button:text-is('Delete')",
      ".Modal button:text-is('Remove')",
      ".Modal button:text-is('Yes')",
    ].join(", "),
  }),
}) satisfies NonNullable<ProviderPortalDefinition["selectors"]["cleanup"]>;

/** At most this many matching rows are removed in one pass. */
const MAX_ROWS = 5;
const ROW_GONE_WAIT_MS = 5_000;
const POLL_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function waitForFewerRows(
  cleanup: ProviderPortalCleanupCapability,
  before: number,
  deadline = Date.now() + ROW_GONE_WAIT_MS,
): Promise<number> {
  const count = await cleanup.count("partRow");
  if (count < before || Date.now() >= deadline) return count;
  // An in-page confirm may render a moment after the remove click.
  await cleanup.click("confirmRemove");
  await sleep(POLL_MS);
  return waitForFewerRows(cleanup, before, deadline);
}

/** Deletes only the upload row proven by the kernel; ambiguity stops the pass. */
export async function cleanupOshcutCart(
  cleanup: ProviderPortalCleanupCapability,
): Promise<ProviderPortalCleanupOutcome> {
  let removed = 0;
  let remaining = await cleanup.count("partRow");
  for (let attempt = 0; attempt < MAX_ROWS && remaining > 0; attempt += 1) {
    if (!(await cleanup.click("removePart"))) break;
    const after = await waitForFewerRows(cleanup, remaining);
    if (after >= remaining) break;
    removed += remaining - after;
    remaining = after;
  }
  return { removed, remaining };
}
