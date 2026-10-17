import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertProviderKillSwitchDisengaged,
  guardProviderDispatch,
  providerDispatchCapModeFromEnv,
  supabaseProviderKillSwitchReader,
  supabaseProviderSettingsPort,
  type ProviderDispatchCapMode,
  type ProviderKillSwitchReader,
  type ProviderSettingsPort,
} from "../providerSettings.js";
import type { VendorName, VendorQuoteAdapterInput } from "../types.js";

/**
 * OVD-751: operator CLI tools that reach live providers consult the same
 * OVD-722 kill switch read as the worker dispatch path. The read is the
 * existing service-role RPC; nothing is written. Any engaged switch or any
 * failure to read the state refuses the run.
 *
 * OVD-829: each live quote also passes the universal supplier settings gate
 * (`guardProviderDispatch`), so operator runs spend the same daily cap as the
 * worker. The cap mode follows WORKER_PROVIDER_DURABLE_DISPATCH_CAP, exactly
 * as the worker does.
 */

/** Reads the switch with the worker's service-role credentials; throws when they are missing. */
export function envProviderKillSwitchReader(
  env: NodeJS.ProcessEnv = process.env,
): ProviderKillSwitchReader {
  return (provider) => supabaseProviderKillSwitchReader(envServiceRoleClient(env))(provider);
}

function envServiceRoleClient(env: NodeJS.ProcessEnv): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("kill switch credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The settings port with the worker's service-role credentials; every read throws when they are missing. */
export function envProviderSettingsPort(
  env: NodeJS.ProcessEnv = process.env,
  reader: ProviderKillSwitchReader = envProviderKillSwitchReader(env),
): ProviderSettingsPort {
  return {
    readKillSwitch: reader,
    readSettings: (provider) => supabaseProviderSettingsPort(envServiceRoleClient(env)).readSettings(provider),
    reserveDispatch: (provider) => supabaseProviderSettingsPort(envServiceRoleClient(env)).reserveDispatch(provider),
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
 * Wraps a live quote in the same settings gate as the worker: immediately
 * before each launch the switch is read and one dispatch is counted against
 * the supplier's daily cap, and the switch guard reaches the adapter's own
 * upload, configure, and save checkpoints. Engaging the switch mid run stops
 * the next provider mutation; a spent cap refuses the next quote.
 */
export function guardOperatorQuote<T>(
  provider: VendorName,
  quote: (input: VendorQuoteAdapterInput) => Promise<T>,
  reader: ProviderKillSwitchReader = envProviderKillSwitchReader(),
  options: { port?: ProviderSettingsPort; capMode?: ProviderDispatchCapMode } = {},
): (input: VendorQuoteAdapterInput) => Promise<T> {
  return guardProviderDispatch({
    provider,
    port: options.port ?? envProviderSettingsPort(process.env, reader),
    capMode: options.capMode ?? providerDispatchCapModeFromEnv(),
    quote,
  });
}
