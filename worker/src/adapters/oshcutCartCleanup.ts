import type {
  ProviderPortalCleanupCapability,
  ProviderPortalCleanupOutcome,
  ProviderPortalDefinition,
} from "./providerPortalKernel.js";

/**
 * OSH Cut exposes no upload-correlated identity. New rows and exact filename
 * matches are manual-cleanup candidates, never authority to delete a part.
 */
export const OSHCUT_CART_ROW = ":has(> .cartInformationArea)";
export const OSHCUT_CART_FILE_NAME = ".cartInformationArea";

export const OSHCUT_CART_CLEANUP_SELECTORS = Object.freeze({
  partRow: Object.freeze({ selector: OSHCUT_CART_ROW, uploadedRows: true, reportOnly: true }),
}) satisfies NonNullable<ProviderPortalDefinition["selectors"]["cleanup"]>;

/** The kernel reports candidate names/counts; no remove or confirm is declared. */
export async function cleanupOshcutCart(
  cleanup: ProviderPortalCleanupCapability,
): Promise<ProviderPortalCleanupOutcome> {
  return { removed: 0, remaining: await cleanup.count("partRow") };
}
