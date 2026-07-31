import { useCallback, useEffect, useState } from "react";
import { callUntypedRpc } from "@/features/quotes/api/shared/rpc";
import { ensureData } from "@/features/quotes/api/shared/response";
import { isFixtureModeEnabled } from "@/features/quotes/client-workspace-fixtures";

export type OrganizationEntitlements = {
  plan: "free" | "pro";
  source: string;
  automaticQuoteCollection: boolean;
  canManageBilling: boolean;
  hasStripeSubscription: boolean;
};

async function fetchOrganizationEntitlements(
  organizationId: string,
): Promise<OrganizationEntitlements> {
  const { data, error } = await callUntypedRpc("api_get_organization_entitlements", {
    p_organization_id: organizationId,
  });

  return ensureData(data, error) as OrganizationEntitlements;
}

export function useOrganizationQuoteCollectionMode(
  organizationId: string | null | undefined,
  enabled = true,
) {
  const [entitlements, setEntitlements] = useState<OrganizationEntitlements | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!organizationId || !enabled) {
      return;
    }

    if (isFixtureModeEnabled()) {
      setEntitlements({
        plan: "free",
        source: "fixture",
        automaticQuoteCollection: false,
        canManageBilling: true,
        hasStripeSubscription: false,
      });
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    fetchOrganizationEntitlements(organizationId)
      .then((nextEntitlements) => {
        if (!cancelled) {
          setEntitlements(nextEntitlements);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntitlements(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, organizationId, refreshVersion]);

  const hasAutomaticEntitlement =
    entitlements?.automaticQuoteCollection === true;

  return {
    automaticEnabled: hasAutomaticEntitlement,
    canManageBilling: entitlements?.canManageBilling === true,
    hasStripeSubscription: entitlements?.hasStripeSubscription === true,
    hasAutomaticEntitlement,
    isLoading,
    plan: entitlements?.plan ?? "free",
    refresh,
  };
}
