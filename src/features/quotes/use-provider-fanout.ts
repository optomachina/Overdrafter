import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { VendorName } from "@/integrations/supabase/types";
import { getProviderFanoutGuards } from "@/features/quotes/api/quote-requests-api";
import { dispatchFanoutProvider } from "@/features/quotes/provider-fanout-dispatch";
import {
  planProviderFanout,
  runProviderFanout,
  type ProviderFanoutOutcome,
  type ProviderFanoutPlan,
  type ProviderFanoutSkipReason,
} from "@/features/quotes/provider-fanout";
import {
  classifyXometryBetaDispatchFailure,
  type ProviderDispatchScope,
  type XometryBetaModelUnits,
} from "@/features/quotes/xometry-beta-dispatch";

export type ProviderFanoutState = {
  plan: ProviderFanoutPlan;
  outcomes: Partial<Record<VendorName, ProviderFanoutOutcome>>;
};

/**
 * Fan out state for one part. Disabled, it returns null and starts nothing, so
 * the flag off path is the single provider flow unchanged.
 */
export function useProviderFanout(input: {
  enabled: boolean;
  jobId: string;
  primary: VendorName;
  candidates: readonly VendorName[];
  scope: ProviderDispatchScope | null;
}) {
  const { enabled, jobId, primary, candidates, scope } = input;
  const guardsQuery = useQuery({
    queryKey: ["provider-fanout-guards", jobId],
    queryFn: () => getProviderFanoutGuards(jobId),
    enabled: enabled && Boolean(jobId),
    retry: false,
    // A background refetch must never add a recipient after the customer has
    // affirmed authority to share; the dialog also resets that box on change.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [outcomes, setOutcomes] = useState<ProviderFanoutState["outcomes"]>({});
  const startedForRef = useRef<string | null>(null);
  const process = scope?.scope.requirements.specification.process;

  const plan = useMemo(
    () =>
      enabled
        ? planProviderFanout({
            primary,
            candidates,
            process: typeof process === "string" ? process : null,
            guards: guardsQuery.data ?? null,
          })
        : null,
    [enabled, primary, candidates, process, guardsQuery.data],
  );

  const recordOutcome = useCallback((outcome: ProviderFanoutOutcome) => {
    setOutcomes((current) => ({ ...current, [outcome.provider]: outcome }));
  }, []);

  /**
   * Sends the confirmed package to every planned provider except the primary.
   * Runs once per approval reference, so an uncertain replay of the primary
   * never sends the extras twice.
   */
  const runExtras = useCallback(
    async (args: {
      approvalReference: string;
      declaredModelUnits: XometryBetaModelUnits;
      confirmedScope: ProviderDispatchScope;
      plan: ProviderFanoutPlan;
    }) => {
      if (startedForRef.current === args.approvalReference) return [];
      startedForRef.current = args.approvalReference;
      return runProviderFanout({
        providers: args.plan.send.filter((provider) => provider !== primary),
        dispatch: (provider) =>
          dispatchFanoutProvider({
            jobId,
            provider,
            declaredModelUnits: args.declaredModelUnits,
            confirmedScope: args.confirmedScope,
            confirmationReference: args.approvalReference,
            confirmedProviders: args.plan.send,
          }),
        classifyFailure: (error) => classifyXometryBetaDispatchFailure(error).status,
        onOutcome: recordOutcome,
      });
    },
    [jobId, primary, recordOutcome],
  );

  /**
   * Records every planned extra as not sent, once per approval reference. Used
   * when the primary was refused because the package changed after review.
   */
  const withholdExtras = useCallback(
    (args: { approvalReference: string; plan: ProviderFanoutPlan; reason: ProviderFanoutSkipReason }) => {
      if (startedForRef.current === args.approvalReference) return;
      startedForRef.current = args.approvalReference;
      for (const provider of args.plan.send) {
        if (provider !== primary) recordOutcome({ provider, status: "denied", skipReason: args.reason });
      }
    },
    [primary, recordOutcome],
  );

  if (!enabled || !plan) return null;
  return {
    plan,
    outcomes,
    isGuardsLoading: guardsQuery.isLoading,
    recordOutcome,
    runExtras,
    withholdExtras,
  };
}
