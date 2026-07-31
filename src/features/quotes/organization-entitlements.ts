import { useEffect, useState } from "react";
import { callUntypedRpc } from "@/features/quotes/api/shared/rpc";
import { ensureData } from "@/features/quotes/api/shared/response";

export type OrganizationEntitlements = {
  plan: "free" | "pro";
  source: string;
  automaticQuoteCollection: boolean;
};

const MODE_CHANGE_EVENT = "overdrafter:quote-collection-mode-change";

function storageKey(organizationId: string): string {
  return `overdrafter:automatic-quote-collection:${organizationId}`;
}

async function fetchOrganizationEntitlements(
  organizationId: string,
): Promise<OrganizationEntitlements> {
  const { data, error } = await callUntypedRpc("api_get_organization_entitlements", {
    p_organization_id: organizationId,
  });

  return ensureData(data, error) as OrganizationEntitlements;
}

function readAutomaticPreference(organizationId: string): boolean {
  return window.localStorage.getItem(storageKey(organizationId)) !== "manual";
}

export function useOrganizationQuoteCollectionMode(
  organizationId: string | null | undefined,
  enabled = true,
) {
  const [entitlements, setEntitlements] = useState<OrganizationEntitlements | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [prefersAutomatic, setPrefersAutomatic] = useState(() =>
    organizationId ? readAutomaticPreference(organizationId) : false,
  );

  useEffect(() => {
    if (!organizationId || !enabled) {
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
  }, [enabled, organizationId]);

  useEffect(() => {
    if (!organizationId) {
      setPrefersAutomatic(false);
      return;
    }

    const syncPreference = () => setPrefersAutomatic(readAutomaticPreference(organizationId));
    syncPreference();
    window.addEventListener(MODE_CHANGE_EVENT, syncPreference);
    window.addEventListener("storage", syncPreference);

    return () => {
      window.removeEventListener(MODE_CHANGE_EVENT, syncPreference);
      window.removeEventListener("storage", syncPreference);
    };
  }, [organizationId]);

  const hasAutomaticEntitlement =
    entitlements?.automaticQuoteCollection === true;
  const automaticEnabled = hasAutomaticEntitlement && prefersAutomatic;

  const setAutomaticEnabled = (enabled: boolean) => {
    if (!organizationId || (enabled && !hasAutomaticEntitlement)) {
      return false;
    }

    window.localStorage.setItem(storageKey(organizationId), enabled ? "automatic" : "manual");
    setPrefersAutomatic(enabled);
    window.dispatchEvent(new Event(MODE_CHANGE_EVENT));
    return true;
  };

  return {
    automaticEnabled,
    hasAutomaticEntitlement,
    isLoading,
    plan: entitlements?.plan ?? "free",
    setAutomaticEnabled,
  };
}
