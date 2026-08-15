import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acceptFoundingBetaNotice,
  getFoundingBetaAccess,
} from "@/features/quotes/api/founding-beta-api";
import type {
  FoundingBetaAccess,
  FoundingBetaUploadStatus,
} from "@/features/quotes/founding-beta-access";

export const FOUNDING_BETA_ACCESS_QUERY_KEY = ["founding-beta-access"] as const;

export function useFoundingBetaAccess(input: {
  organizationId?: string;
  userId?: string;
  enabled?: boolean;
}) {
  const { organizationId, userId, enabled = true } = input;
  const queryClient = useQueryClient();
  const accessQuery = useQuery({
    queryKey: [...FOUNDING_BETA_ACCESS_QUERY_KEY, organizationId, userId],
    queryFn: () => getFoundingBetaAccess(organizationId!),
    enabled: enabled && Boolean(organizationId) && Boolean(userId),
    retry: false,
  });

  const acceptNoticeMutation = useMutation({
    mutationFn: async () => {
      if (!organizationId || !accessQuery.data) {
        throw new Error("Founding Beta access could not be verified.");
      }

      return acceptFoundingBetaNotice({
        organizationId,
        policyRevision: accessQuery.data.policyRevision,
      });
    },
    onSuccess: (access) => {
      queryClient.setQueryData<FoundingBetaAccess>(
        [...FOUNDING_BETA_ACCESS_QUERY_KEY, organizationId, userId],
        access,
      );
    },
  });

  const acceptNotice = async () => {
    try {
      return await acceptNoticeMutation.mutateAsync();
    } catch (error) {
      await accessQuery.refetch();
      throw error;
    }
  };

  let status: FoundingBetaUploadStatus = "loading";
  if (!enabled || !organizationId || !userId || accessQuery.isError) {
    status = "unavailable";
  } else if (accessQuery.data) {
    status = accessQuery.data.state;
  }

  return {
    access: accessQuery.data ?? null,
    status,
    canUpload: status === "eligible",
    acceptNotice,
    isAcceptingNotice: acceptNoticeMutation.isPending,
    acceptanceError: acceptNoticeMutation.error,
    refetch: accessQuery.refetch,
  };
}
