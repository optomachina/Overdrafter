import { useCallback, useEffect, useRef, useState } from "react";
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
  const inFlightRequest = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!organizationId || !enabled) {
      requestVersion.current += 1;
      setEntitlements(null);
      setIsLoading(false);
      return;
    }

    const requestKey = `${organizationId}:${enabled}`;
    if (inFlightRequest.current?.key === requestKey) {
      return inFlightRequest.current.promise;
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

    const currentVersion = requestVersion.current + 1;
    requestVersion.current = currentVersion;
    setIsLoading(true);

    const request = fetchOrganizationEntitlements(organizationId)
      .then((nextEntitlements) => {
        if (requestVersion.current === currentVersion) {
          setEntitlements(nextEntitlements);
        }
      })
      .catch(() => {
        if (requestVersion.current === currentVersion) {
          setEntitlements(null);
        }
      })
      .finally(() => {
        if (requestVersion.current === currentVersion) {
          setIsLoading(false);
        }
        if (inFlightRequest.current?.promise === request) {
          inFlightRequest.current = null;
        }
      });

    inFlightRequest.current = { key: requestKey, promise: request };
    return request;
  }, [enabled, organizationId]);

  useEffect(() => {
    void refresh();

    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);

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
