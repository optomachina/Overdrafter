import type { VendorQuoteAdapterInput } from "../types.js";
import type {
  ProviderPortalCleanupCapability,
  ProviderPortalCleanupOutcome,
  ProviderPortalDefinition,
} from "./providerPortalKernel.js";

/**
 * OSH Cut cart cleanup (Blaine's standing rule, 2026-10-15): once the price
 * is read, or after a failure that followed upload, the uploaded part is
 * deleted from the cart on `/cart/O-<uuid>`. Only rows that show the staged
 * file name are touched, so other parts in the account cart stay.
 *
 * The capture of 2026-10-15 did not open the delete control, so these
 * selectors are a reviewed guess: a remove/delete/trash control inside the
 * part row, then an in-page confirm button if one appears (a native confirm
 * is accepted by the kernel). A miss is reported as `not_found` or
 * `incomplete` in the `providerPortalCleanup` log for manual removal.
 */
export const OSHCUT_CART_CLEANUP_SELECTORS = Object.freeze({
  partRow: Object.freeze({ selector: ":has(> .cartInformationArea)" }),
  removePart: Object.freeze({
    scope: ":has(> .cartInformationArea)",
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

function stagedFileName(input: VendorQuoteAdapterInput): string | null {
  const name = input.stagedCadFile?.originalName ?? input.cadFile?.original_name ?? null;
  return name?.trim() || null;
}

async function waitForFewerRows(
  cleanup: ProviderPortalCleanupCapability,
  name: string,
  before: number,
  deadline = Date.now() + ROW_GONE_WAIT_MS,
): Promise<number> {
  const count = await cleanup.count("partRow", name);
  if (count < before || Date.now() >= deadline) return count;
  // An in-page confirm may render a moment after the remove click.
  await cleanup.click("confirmRemove");
  await sleep(POLL_MS);
  return waitForFewerRows(cleanup, name, before, deadline);
}

/** Deletes every cart row that shows the staged file name; reports what is left. */
export async function cleanupOshcutCart(
  cleanup: ProviderPortalCleanupCapability,
  input: VendorQuoteAdapterInput,
): Promise<ProviderPortalCleanupOutcome> {
  const name = stagedFileName(input);
  if (!name) return { removed: 0, remaining: Number.NaN };
  let removed = 0;
  let remaining = await cleanup.count("partRow", name);
  for (let attempt = 0; attempt < MAX_ROWS && remaining > 0; attempt += 1) {
    if (!(await cleanup.click("removePart", name))) break;
    const after = await waitForFewerRows(cleanup, name, remaining);
    if (after >= remaining) break;
    removed += remaining - after;
    remaining = after;
  }
  return { removed, remaining };
}
