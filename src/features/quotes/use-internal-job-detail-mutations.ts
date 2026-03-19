import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  approveJobRequirements,
  publishQuotePackage,
  requestExtraction,
  resendSignupConfirmation,
  startQuoteRun,
} from "@/features/quotes/api";
import type { ApprovedPartRequirement } from "@/features/quotes/types";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { supabase } from "@/integrations/supabase/client";

type UseInternalJobDetailMutationsInput = {
  jobId: string;
  normalizedApprovedDrafts: ApprovedPartRequirement[];
  latestQuoteRunId: string | null;
  clientSummary: string;
  readinessReady: boolean | undefined;
  userEmail: string | undefined;
  signOut: () => Promise<void>;
};

export type UseInternalJobDetailMutationsResult = {
  queueExtraction: () => void;
  saveApprovedRequirements: () => void;
  startQuoteRun: () => void;
  publishPackage: () => void;
  refreshVerification: () => Promise<void>;
  resendVerification: () => Promise<void>;
  changeEmail: () => Promise<void>;
  isQueueingExtraction: boolean;
  isSavingRequirements: boolean;
  isStartingQuoteRun: boolean;
  isPublishingPackage: boolean;
  isRefreshingVerification: boolean;
  isResendingVerification: boolean;
};

export function useInternalJobDetailMutations({
  jobId,
  normalizedApprovedDrafts,
  latestQuoteRunId,
  clientSummary,
  readinessReady,
  userEmail,
  signOut,
}: UseInternalJobDetailMutationsInput): UseInternalJobDetailMutationsResult {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);

  const requestExtractionMutation = useMutation({
    mutationFn: () => requestExtraction(jobId),
    onSuccess: async () => {
      toast.success("Extraction queue refreshed.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to queue extraction."),
  });

  const saveRequirementsMutation = useMutation({
    mutationFn: () => approveJobRequirements(jobId, normalizedApprovedDrafts),
    onSuccess: async (approvedCount) => {
      toast.success(`Approved ${approvedCount} part requirement set(s).`);
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to save approved requirements."),
  });

  const startQuoteRunMutation = useMutation({
    mutationFn: () => startQuoteRun(jobId, true),
    onSuccess: async () => {
      toast.success("Quote run started.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to start quote run."),
  });

  const publishMutation = useMutation({
    mutationFn: () => {
      if (!latestQuoteRunId) {
        throw new Error("A latest quote run is required before publishing a quote package.");
      }

      return publishQuotePackage({
        jobId,
        quoteRunId: latestQuoteRunId,
        clientSummary,
        force: !readinessReady,
      });
    },
    onSuccess: async () => {
      toast.success("Quote package published.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
      ]);
    },
    onError: (error: Error) => toast.error(error.message || "Failed to publish quote package."),
  });

  const refreshVerification = async () => {
    setIsRefreshingVerification(true);

    try {
      const { data, error } = await supabase.auth.getUser();

      if (error) {
        throw error;
      }

      if (!data.user) {
        throw new Error("Open the confirmation link from your email first.");
      }

      if (isEmailConfirmationRequired(data.user)) {
        throw new Error("Email confirmation has not completed yet.");
      }

      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      toast.success("Email verified.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh verification status.");
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const resendVerification = async () => {
    if (!userEmail) {
      toast.error("No email is available for this account.");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(userEmail);
      toast.success(`Confirmation email resent to ${userEmail}.`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to resend confirmation email.");
    } finally {
      setIsResendingVerification(false);
    }
  };

  const changeEmail = async () => {
    try {
      await signOut();
      navigate("/?auth=signup", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to sign out.");
    }
  };

  return {
    queueExtraction: () => requestExtractionMutation.mutate(),
    saveApprovedRequirements: () => saveRequirementsMutation.mutate(),
    startQuoteRun: () => startQuoteRunMutation.mutate(),
    publishPackage: () => publishMutation.mutate(),
    refreshVerification,
    resendVerification,
    changeEmail,
    isQueueingExtraction: requestExtractionMutation.isPending,
    isSavingRequirements: saveRequirementsMutation.isPending,
    isStartingQuoteRun: startQuoteRunMutation.isPending,
    isPublishingPackage: publishMutation.isPending,
    isRefreshingVerification,
    isResendingVerification,
  };
}
