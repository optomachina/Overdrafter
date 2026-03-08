import { ChangeEvent, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Sparkles, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { useAppSession } from "@/hooks/use-app-session";
import {
  createJob,
  inferFileKind,
  reconcileJobParts,
  requestExtraction,
  resendSignupConfirmation,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { createCadPreviewSourceFromFile, isStepPreviewableFile } from "@/lib/cad-preview";
import { supabase } from "@/integrations/supabase/client";
import { formatStatusLabel } from "@/features/quotes/utils";
import {
  ALLOWED_QUOTE_UPLOAD_EXTENSIONS,
  validateQuoteFiles,
} from "@/features/quotes/file-validation";

function parseJobTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

const JobCreate = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user, activeMembership, isVerifiedAuth, signOut } = useAppSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [matchSummary, setMatchSummary] = useState<Record<string, number> | null>(null);
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);

  const createJobMutation = useMutation({
    mutationFn: async () => {
      if (!activeMembership) {
        throw new Error("No account context is available yet.");
      }

      const jobId = await createJob({
        organizationId: activeMembership.organizationId,
        title,
        description,
        source: activeMembership.role === "client" ? "client" : "internal",
        tags: parseJobTags(tagInput),
      });

      const uploadSummary = await uploadFilesToJob(jobId, files);
      const summary =
        uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0 ? await reconcileJobParts(jobId) : null;

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await requestExtraction(jobId);
      }

      return {
        jobId,
        summary,
      };
    },
    onSuccess: async ({ jobId, summary }) => {
      setMatchSummary(summary);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
      ]);

      toast.success("Job created and extraction queued.");

      if (activeMembership?.role === "client") {
        navigate("/");
      } else {
        navigate(`/internal/jobs/${jobId}`);
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create job");
    },
  });

  const fileSummary = useMemo(
    () =>
      files.map((file) => ({
        file,
        name: file.name,
        sizeMb: (file.size / (1024 * 1024)).toFixed(2),
        kind: inferFileKind(file.name),
        previewSource: isStepPreviewableFile(file.name) ? createCadPreviewSourceFromFile(file) : null,
      })),
    [files],
  );

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const { accepted, errors } = validateQuoteFiles(Array.from(event.target.files ?? []));
    errors.forEach((error) => toast.error(error));
    setFiles((current) => [...current, ...accepted]);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
  };

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
    if (!user?.email) {
      toast.error("No email is available for this account.");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(user.email);
      toast.success(`Confirmation email resent to ${user.email}.`);
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

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership) {
    return <Navigate to="/" replace />;
  }

  return (
    <AppShell
      title="Create CNC Quote Job"
      subtitle="Create a job, attach CAD and drawing files, match them into parts, and queue structured extraction."
      actions={
        <Button
          className="rounded-full"
          onClick={() => createJobMutation.mutate()}
          disabled={!isVerifiedAuth || !title.trim() || files.length === 0 || createJobMutation.isPending}
        >
          {createJobMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating job
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Create and queue extraction
            </>
          )}
        </Button>
      }
    >
      {!isVerifiedAuth && user?.email ? (
        <div className="mb-6">
          <EmailVerificationPrompt
            email={user.email}
            isRefreshing={isRefreshingVerification}
            isResending={isResendingVerification}
            onRefreshSession={() => {
              void handleRefreshVerification();
            }}
            onResend={() => {
              void handleResendVerification();
            }}
            onChangeEmail={() => {
              void handleChangeEmail();
            }}
          />
        </div>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Job details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="job-title">Job title</Label>
              <Input
                id="job-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={!isVerifiedAuth}
                placeholder="Flight bracket RFQ"
                className="border-white/10 bg-black/20"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="job-description">Description</Label>
              <Textarea
                id="job-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!isVerifiedAuth}
                placeholder="Customer-facing CNC job for bracket and housing components."
                className="min-h-32 border-white/10 bg-black/20"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="job-tags">Tags</Label>
              <Input
                id="job-tags"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                disabled={!isVerifiedAuth}
                placeholder="Demo, Priority, Customer A"
                className="border-white/10 bg-black/20"
              />
              <p className="text-xs text-white/45">
                Optional comma-separated labels for filtering and internal organization.
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-white/55">
              <p className="font-medium text-white">Account</p>
              <p className="mt-1">{activeMembership.organizationName}</p>
              <p className="mt-4 font-medium text-white">Role</p>
              <p className="mt-1">{formatStatusLabel(activeMembership.role)}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>Files</CardTitle>
              <p className="mt-2 text-sm text-white/55">
                Upload STEP or similar CAD files plus PDF drawings. Matching is filename-based and case-insensitive.
              </p>
            </div>
            <Button
              variant="outline"
              className="border-white/10 bg-white/5"
              onClick={() => fileInputRef.current?.click()}
              disabled={!isVerifiedAuth}
            >
              <Upload className="mr-2 h-4 w-4" />
              Add files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              disabled={!isVerifiedAuth}
              onChange={handleFileUpload}
              accept={ALLOWED_QUOTE_UPLOAD_EXTENSIONS.join(",")}
            />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 p-6 text-center">
              <FileUp className="mx-auto h-10 w-10 text-primary" />
              <p className="mt-4 font-medium">Drop files into the picker above</p>
              <p className="mt-2 text-sm text-white/50">
                Supported: STEP, STP, IGES, SolidWorks part files, Parasolid, and PDF drawings. STEP uploads get a local 3D preview before submission.
              </p>
            </div>

            {fileSummary.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {fileSummary.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="rounded-[1.75rem] border border-white/8 bg-black/20 p-3"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row">
                      {isStepPreviewableFile(file.name) ? (
                        <CadModelThumbnail
                          source={file.previewSource!}
                          className="h-40 w-full shrink-0 sm:w-40"
                        />
                      ) : (
                        <div className="flex h-40 w-full shrink-0 flex-col items-center justify-center rounded-[1.4rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(11,15,24,0.95))] sm:w-40">
                          <div className="rounded-full border border-white/10 bg-white/5 p-3">
                            <FileUp className="h-6 w-6 text-primary" />
                          </div>
                          <Badge
                            variant="secondary"
                            className="mt-4 border border-white/10 bg-white/5 text-white/70"
                          >
                            {formatStatusLabel(file.kind)}
                          </Badge>
                          <p className="mt-2 px-3 text-center text-xs text-white/45">
                            Preview available for `.step` and `.stp` uploads.
                          </p>
                        </div>
                      )}

                      <div className="flex min-w-0 flex-1 flex-col justify-between gap-4 py-1">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{file.name}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/50">
                            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                              {formatStatusLabel(file.kind)}
                            </Badge>
                            <span>{file.sizeMb} MB</span>
                            {isStepPreviewableFile(file.name) ? (
                              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-primary">
                                Interactive preview
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-white/55 hover:bg-white/5 hover:text-white"
                            onClick={() => removeFile(index)}
                            disabled={!isVerifiedAuth}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {matchSummary ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4 text-sm text-primary">
                <p className="font-medium">Latest match summary</p>
                <p className="mt-2">
                  {matchSummary.totalParts ?? 0} parts identified, {matchSummary.matchedPairs ?? 0} CAD/PDF pairs,
                  {matchSummary.missingDrawings ?? 0} missing drawings, {matchSummary.missingCad ?? 0} missing CAD files.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </AppShell>
  );
};

export default JobCreate;
