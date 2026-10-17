/**
 * OVD-829: a synthetic answer from `api_worker_reserve_provider_dispatch` for
 * test doubles of the Supabase client. Defaults to an allowed reservation for
 * an uncapped supplier (there is no default cap).
 */
export const PROVIDER_DISPATCH_RESERVE_RPC_NAME = "api_worker_reserve_provider_dispatch";

export function providerDispatchReservation(provider: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schema: "provider-dispatch-reservation.v1",
    provider,
    allowed: true,
    reason: null,
    cap: null,
    used: 1,
    ...overrides,
  };
}
