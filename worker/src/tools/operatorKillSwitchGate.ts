import { createClient } from "@supabase/supabase-js";
import {
  assertProviderKillSwitchDisengaged,
  createProviderKillSwitchGuard,
  guardProviderQuote,
  supabaseProviderKillSwitchReader,
  type ProviderKillSwitchReader,
} from "../providerKillSwitch.js";
import type { VendorName, VendorQuoteAdapterInput } from "../types.js";

/**
 * OVD-751: operator CLI tools that reach live providers consult the same
 * OVD-722 kill switch read as the worker dispatch path. The read is the
 * existing service-role RPC; nothing is written. Any engaged switch or any
 * failure to read the state refuses the run.
 */

/** Reads the switch with the worker's service-role credentials; throws when they are missing. */
export function envProviderKillSwitchReader(
  env: NodeJS.ProcessEnv = process.env,
): ProviderKillSwitchReader {
  return (provider) => {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("kill switch credentials are not configured");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return supabaseProviderKillSwitchReader(supabase)(provider);
  };
}

/**
 * Resolves only when every provider is verifiably enabled. Throws a
 * `ProviderKillSwitchError` otherwise, before any live provider call.
 */
export async function assertOperatorProvidersEnabled(
  providers: readonly VendorName[],
  reader: ProviderKillSwitchReader = envProviderKillSwitchReader(),
): Promise<void> {
  for (const provider of new Set(providers)) {
    await assertProviderKillSwitchDisengaged({ reader, provider, checkpoint: "before_launch" });
  }
}

/**
 * Wraps a live quote so the switch is read immediately before each launch and
 * the same guard reaches the adapter's own upload, configure, and save
 * checkpoints. Engaging the switch mid run stops the next provider mutation.
 */
export function guardOperatorQuote<T>(
  provider: VendorName,
  quote: (input: VendorQuoteAdapterInput) => Promise<T>,
  reader: ProviderKillSwitchReader = envProviderKillSwitchReader(),
): (input: VendorQuoteAdapterInput) => Promise<T> {
  return guardProviderQuote(createProviderKillSwitchGuard(reader, provider), quote);
}
