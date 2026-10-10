import type { LiveDispatchProvider } from "@/features/quotes/xometry-beta-dispatch";

/**
 * Which provider the customer confirmation flow targets (OVD-673). Defaults to
 * Xometry; only the exact value "fictiv" selects the generic Fictiv path, and
 * the server still denies it until Fictiv is admitted. Unknown values fall back
 * to Xometry rather than widening disclosure.
 */
export function resolveLiveDispatchProvider(rawValue: string | undefined | null): LiveDispatchProvider {
  return rawValue?.trim().toLowerCase() === "fictiv" ? "fictiv" : "xometry";
}

export function getConfiguredLiveDispatchProvider(): LiveDispatchProvider {
  return resolveLiveDispatchProvider(import.meta.env.VITE_LIVE_DISPATCH_PROVIDER as string | undefined);
}
