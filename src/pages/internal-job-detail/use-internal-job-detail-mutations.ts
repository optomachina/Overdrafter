import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { approveJobRequirements, requestExtraction } from "@/features/quotes/api/extraction-api";
import { publishQuotePackage } from "@/features/quotes/api/packages-api";
import { resendSignupConfirmation } from "@/features/quotes/api/session-api";
import { startQuoteRun } from "@/features/quotes/api/quote-requests-api";
import { normalizeApprovedRequirementDraft } from "@/features/quotes/request-scenarios";
import type { ApprovedPartRequirement } from "@/features/quotes/types";

type UseInternalJobDetailMutationsOptions = {
  clientSummary: string;
  drafts: Record<string, ApprovedPartRequirement>;
  forcePublish: boolean;
  jobId: string;
  latestQuoteRunId: string | null;
  navigate: NavigateFunction;
  signOut: () => Promise<void>;
  userEmail: string | null;
};

export function useInternalJobDetailMutations({
  clientSummary,
  drafts,
  forcePublish,
  jobId,
  latestQuoteRunId,
  navigate,
  signOut,
  userEmail,
}: UseInternalJobDetailMutationsOptions) {
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
    mutationFn: () =>
      approveJobRequirements(
        jobId,
        Object.values(drafts).map((draft) => normalizeApprovedRequirementDraft(draft)),
      ),
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
    mutationFn: async () => {
      if (!latestQuoteRunId) {
        throw new Error("No quote run is available to publish.");
      }

      return publishQuotePackage({
        jobId,
        quoteRunId: latestQuoteRunId,
        clientSummary,
        force: forcePublish,
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

  const handleRefreshVerification = async () => {
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

  const handleResendVerification = async () => {
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

  const handleChangeEmail = async () => {
    try {
      await signOut();
      navigate("/?auth=signup", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to sign out.");
    }
  };

  return {
    handleChangeEmail,
    handleRefreshVerification,
    handleResendVerification,
    isRefreshingVerification,
    isResendingVerification,
    publishMutation,
    requestExtractionMutation,
    saveRequirementsMutation,
    startQuoteRunMutation,
  };
}
