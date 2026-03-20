import { supabase } from "@/integrations/supabase/client";
import { getUserFacingErrorMessage, toUserFacingError } from "@/lib/error-message";
import { resolveStoredFileViewerMode } from "@/lib/file-viewer";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";

export const FIXTURE_STORAGE_BUCKET = "fixture-public";

type StoredFileLike = {
  storage_bucket: string;
  storage_path: string;
  original_name?: string | null;
  mime_type?: string | null;
};

type ResolvedStoredFileAccess =
  | {
      kind: "fixture";
      url: string;
      sanitizedUrl: string;
    }
  | {
      kind: "signed";
      url: string;
      sanitizedUrl: string;
    };

function resolveFixtureAssetUrl(storagePath: string): string {
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    return storagePath;
  }

  return storagePath.startsWith("/") ? storagePath : `/${storagePath}`;
}

export function isFixtureStoredFile(file: Pick<StoredFileLike, "storage_bucket">): boolean {
  return file.storage_bucket === FIXTURE_STORAGE_BUCKET;
}

function sanitizeUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

async function resolveStoredFileAccess(file: StoredFileLike): Promise<ResolvedStoredFileAccess> {
  if (isFixtureStoredFile(file)) {
    const url = resolveFixtureAssetUrl(file.storage_path);
    return {
      kind: "fixture",
      url,
      sanitizedUrl: sanitizeUrlForDiagnostics(url),
    };
  }

  const { data, error } = await supabase.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 60);

  if (error || !data?.signedUrl) {
    const fallbackMessage = `Unable to prepare ${file.original_name ?? file.storage_path} for preview.`;
    throw toUserFacingError(error, fallbackMessage);
  }

  return {
    kind: "signed",
    url: data.signedUrl,
    sanitizedUrl: sanitizeUrlForDiagnostics(data.signedUrl),
  };
}

function buildPdfPreviewFetchErrorMessage(status: number, file: StoredFileLike): string {
  if (status === 401 || status === 403) {
    return "Drawing preview link expired or is no longer valid. Refresh and try again.";
  }

  if (status === 404) {
    return `Drawing preview could not be found for ${file.original_name ?? file.storage_path}.`;
  }

  return `Unable to load ${file.original_name ?? file.storage_path}.`;
}

function coercePdfBlob(blob: Blob, file: StoredFileLike): Blob {
  if (blob.size === 0) {
    throw new Error("Drawing preview is empty.");
  }

  if (blob.type === "application/pdf") {
    return blob;
  }

  const viewerMode = resolveStoredFileViewerMode(file);
  if (viewerMode === "pdf") {
    return new Blob([blob], { type: "application/pdf" });
  }

  return blob;
}

export async function downloadStoredFileBlob(file: StoredFileLike): Promise<Blob> {
  if (isFixtureStoredFile(file)) {
    const response = await fetch(resolveFixtureAssetUrl(file.storage_path));

    if (!response.ok) {
      throw new Error(`Unable to download ${file.original_name ?? file.storage_path}.`);
    }

    return await response.blob();
  }

  const { data, error } = await supabase.storage.from(file.storage_bucket).download(file.storage_path);

  if (error || !data) {
    const fallbackMessage = `Unable to download ${file.original_name ?? file.storage_path}.`;
    const normalizedMessage =
      error && typeof error === "object" && "details" in error && typeof error.details === "string" && error.details.trim()
        ? error.details.trim()
        : getUserFacingErrorMessage(error, fallbackMessage);
    throw toUserFacingError(
      error && typeof error === "object" ? { ...error, message: normalizedMessage } : error,
      fallbackMessage,
    );
  }

  return data;
}

export async function downloadStoredFileBytes(file: StoredFileLike): Promise<Uint8Array> {
  const blob = await downloadStoredFileBlob(file);
  return new Uint8Array(await blob.arrayBuffer());
}

export async function loadStoredPdfObjectUrl(file: StoredFileLike): Promise<string> {
  const viewerMode = resolveStoredFileViewerMode(file);
  if (viewerMode !== "pdf") {
    throw new Error(`Cannot render ${file.original_name ?? file.storage_path} as a PDF preview.`);
  }

  const access = await resolveStoredFileAccess(file);

  recordWorkspaceSessionDiagnostic("info", "stored-file.pdf-preview", "Loading PDF preview.", {
    storageBucket: file.storage_bucket,
    storagePath: file.storage_path,
    resolvedUrl: access.sanitizedUrl,
    reportedMimeType: file.mime_type ?? null,
    viewerMode,
  });

  let response: Response;

  try {
    response = await fetch(access.url);
  } catch (error) {
    recordWorkspaceSessionDiagnostic("warn", "stored-file.pdf-preview", "PDF preview fetch failed.", {
      storageBucket: file.storage_bucket,
      storagePath: file.storage_path,
      resolvedUrl: access.sanitizedUrl,
      reportedMimeType: file.mime_type ?? null,
      viewerMode,
      error: getUserFacingErrorMessage(error, "Network or CORS failure."),
    });
    throw new Error("Unable to load drawing preview due to a network or CORS error.");
  }

  const responseContentType = response.headers.get("content-type");
  const responseContentLength = response.headers.get("content-length");

  recordWorkspaceSessionDiagnostic("info", "stored-file.pdf-preview", "PDF preview response received.", {
    storageBucket: file.storage_bucket,
    storagePath: file.storage_path,
    resolvedUrl: access.sanitizedUrl,
    viewerMode,
    responseStatus: response.status,
    responseContentType,
    responseContentLength,
  });

  if (!response.ok) {
    throw new Error(buildPdfPreviewFetchErrorMessage(response.status, file));
  }

  const blob = coercePdfBlob(await response.blob(), file);

  recordWorkspaceSessionDiagnostic("info", "stored-file.pdf-preview", "PDF preview blob ready.", {
    storageBucket: file.storage_bucket,
    storagePath: file.storage_path,
    resolvedUrl: access.sanitizedUrl,
    viewerMode,
    responseContentType,
    responseContentLength,
    blobSize: blob.size,
    blobType: blob.type,
  });

  return URL.createObjectURL(blob);
}
