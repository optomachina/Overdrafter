import type { SupabaseClient as RootSupabaseClient } from "@supabase/supabase-js";
import { expectTypeOf, it } from "vitest";
import type { CapabilityObservationReader, recordProviderUploadCapabilityObservation } from "../../worker/src/providerUploadCapabilityPersistence";

// The write API retains the actual worker SDK class, preserving both installed identities.
type WorkerSupabaseClient = Parameters<typeof recordProviderUploadCapabilityObservation>[0];
it("accepts both real installed SDK clients at the read-only resolver boundary", () => {
  expectTypeOf<RootSupabaseClient>().toMatchTypeOf<CapabilityObservationReader>();
  expectTypeOf<WorkerSupabaseClient>().toMatchTypeOf<CapabilityObservationReader>();
});
