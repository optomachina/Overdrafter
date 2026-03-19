import { supabase } from "@/integrations/supabase/client";
import type {
  ManualQuoteArtifactInput,
  PrepareJobFileUploadResult,
  UploadFilesToJobSummary,
} from "@/features/quotes/types";
import type { JobFileKind, Json } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { buildAutoProjectName, groupUploadFiles } from "@/features/quotes/upload-groups";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";
import { createClientDraft } from "./jobs-api";
import { createProject } from "./projects-api";
import { reconcileJobParts, requestExtraction } from "./extraction-api";

const CAD_EXTENSIONS = new Set([
  "step",
  "stp",
  "iges",
  "igs",
  "sldprt",
  "prt",
  "sldasm",
  "asm",
  "x_t",
  "xt",
]);

const DRAWING_EXTENSIONS = new Set(["pdf"]);

type HashedUploadFile = {
  file: File;
  contentSha256: string;
};

function sanitizeStorageFileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function inferFileKind(fileName: string): JobFileKind {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (DRAWING_EXTENSIONS.has(extension)) {
    return "drawing";
  }

  if (CAD_EXTENSIONS.has(extension)) {
    return "cad";
  }

  return "other";
}

async function computeFileSha256(file: File): Promise<string> {
  const fileBuffer =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : new TextEncoder().encode(await file.text()).buffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  return Array.from(new Uint8Array(hashBuffer), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashUploadFiles(files: File[]): Promise<HashedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => ({
      file,
      contentSha256: await computeFileSha256(file),
    })),
  );
}

export async function findDuplicateUploadSelections(files: File[]): Promise<string[]> {
  const hashedFiles = await hashUploadFiles(files);
  const seenHashes = new Set<string>();
  const duplicates: string[] = [];

  for (const hashedFile of hashedFiles) {
    if (seenHashes.has(hashedFile.contentSha256)) {
      duplicates.push(hashedFile.file.name);
      continue;
    }

    seenHashes.add(hashedFile.contentSha256);
  }

  return duplicates;
}

function isStorageObjectExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { message?: unknown; statusCode?: unknown; error?: unknown };
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const errorCode = typeof value.error === "string" ? value.error.toLowerCase() : "";
  const statusCode = typeof value.statusCode === "string" ? value.statusCode : "";

  return (
    statusCode === "409" ||
    message.includes("already exists") ||
    message.includes("duplicate") ||
    errorCode.includes("duplicate")
  );
}

export async function createJobsFromUploadFiles(input: {
  files: File[];
  prompt?: string;
  projectId?: string | null;
}): Promise<{ jobIds: string[]; projectId: string | null }> {
  const groups = groupUploadFiles(input.files);
  const requestIntake = parseRequestIntake(input.prompt ?? "");

  if (groups.length === 0) {
    return { jobIds: [], projectId: input.projectId ?? null };
  }

  let targetProjectId = input.projectId ?? null;

  if (!targetProjectId && groups.length > 1) {
    targetProjectId = await createProject({
      name: buildAutoProjectName(input.prompt ?? "", groups),
    });
  }

  const jobIds: string[] = [];

  for (const group of groups) {
    const title = buildDraftTitleFromPrompt("", group.files);
    const jobId = await createClientDraft({
      title,
      description: input.prompt?.trim() || undefined,
      projectId: targetProjectId,
      tags: [],
      requestedServiceKinds: requestIntake.requestedServiceKinds,
      primaryServiceKind: requestIntake.primaryServiceKind,
      serviceNotes: requestIntake.serviceNotes,
      requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
      requestedByDate: requestIntake.requestedByDate,
    });

    await uploadFilesToJob(jobId, group.files);
    await reconcileJobParts(jobId);
    await requestExtraction(jobId);
    jobIds.push(jobId);
  }

  return { jobIds, projectId: targetProjectId };
}

export async function uploadFilesToJob(jobId: string, files: File[]): Promise<UploadFilesToJobSummary> {
  const hashedFiles = await hashUploadFiles(files);
  const seenHashes = new Set<string>();
  const duplicateNames: string[] = [];
  let uploadedCount = 0;
  let reusedCount = 0;

  for (const hashedFile of hashedFiles) {
    const { file, contentSha256 } = hashedFile;

    if (seenHashes.has(contentSha256)) {
      duplicateNames.push(file.name);
      toast.error(`${file.name} is duplicated in this upload batch and was skipped.`);
      continue;
    }

    seenHashes.add(contentSha256);

    const fileKind = inferFileKind(file.name);
    const { data, error } = await callRpc("api_prepare_job_file_upload", {
      p_job_id: jobId,
      p_original_name: file.name,
      p_file_kind: fileKind,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
      p_content_sha256: contentSha256,
    });

    const prepareResult = ensureData(data, error) as PrepareJobFileUploadResult;

    if (prepareResult.status === "duplicate_in_job") {
      duplicateNames.push(file.name);
      toast.error(`${file.name} is already attached to this part.`);
      continue;
    }

    if (prepareResult.status === "reused") {
      reusedCount += 1;
      continue;
    }

    const { error: storageError } = await supabase.storage
      .from(prepareResult.storageBucket)
      .upload(prepareResult.storagePath, file, { upsert: false });

    if (storageError && !isStorageObjectExistsError(storageError)) {
      throw storageError;
    }

    const { error: finalizeError } = await callRpc("api_finalize_job_file_upload", {
      p_job_id: jobId,
      p_storage_bucket: prepareResult.storageBucket,
      p_storage_path: prepareResult.storagePath,
      p_original_name: file.name,
      p_file_kind: fileKind,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
      p_content_sha256: contentSha256,
    });

    if (finalizeError) {
      throw finalizeError;
    }

    uploadedCount += 1;
  }

  if (reusedCount > 0) {
    toast.success(`Reused ${reusedCount} existing file${reusedCount === 1 ? "" : "s"} from your workspace.`);
  }

  return {
    uploadedCount,
    reusedCount,
    duplicateNames,
  };
}

export async function uploadManualQuoteEvidence(
  jobId: string,
  files: File[],
): Promise<ManualQuoteArtifactInput[]> {
  const uploadedArtifacts: ManualQuoteArtifactInput[] = [];

  for (const file of files) {
    const storagePath = `manual-quotes/${jobId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeStorageFileName(file.name)}`;

    const { error: storageError } = await supabase.storage
      .from("quote-artifacts")
      .upload(storagePath, file, {
        upsert: false,
        contentType: file.type || undefined,
      });

    if (storageError) {
      throw storageError;
    }

    uploadedArtifacts.push({
      artifactType: "uploaded_evidence",
      storageBucket: "quote-artifacts",
      storagePath,
      metadata: {
        originalName: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
      } satisfies Json,
    });
  }

  return uploadedArtifacts;
}
