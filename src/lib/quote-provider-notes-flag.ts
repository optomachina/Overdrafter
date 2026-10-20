/** Client flag for showing provider notes in the part-page quote detail. Default off. */
export function isQuoteProviderNotesEnabled(
  value: string | undefined = import.meta.env.VITE_ENABLE_QUOTE_PROVIDER_NOTES,
): boolean {
  return value === "1";
}
