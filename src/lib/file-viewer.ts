export type StoredFileViewerMode = "pdf" | "image" | "text" | "download";

type StoredFileDescriptor = {
  original_name?: string | null;
  mime_type?: string | null;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "json", "log", "md", "yaml", "yml", "xml"]);
const TEXT_MIME_TYPES = new Set(["application/json", "application/ld+json", "text/csv"]);

function normalizeMimeType(mimeType: string | null | undefined): string | null {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }

  return normalized.split(";")[0] ?? null;
}

function getFileExtension(fileName: string | null | undefined): string | null {
  const normalized = fileName?.trim().toLowerCase() ?? "";
  if (!normalized || !normalized.includes(".")) {
    return null;
  }

  return normalized.split(".").pop() ?? null;
}

export function resolveStoredFileViewerMode(file: StoredFileDescriptor | null | undefined): StoredFileViewerMode {
  const mimeType = normalizeMimeType(file?.mime_type);
  const extension = getFileExtension(file?.original_name);

  if (mimeType === "application/pdf" || extension === "pdf") {
    return "pdf";
  }

  if ((mimeType && mimeType.startsWith("image/")) || (extension && IMAGE_EXTENSIONS.has(extension))) {
    return "image";
  }

  if (
    (mimeType && mimeType.startsWith("text/")) ||
    (mimeType && TEXT_MIME_TYPES.has(mimeType)) ||
    (extension && TEXT_EXTENSIONS.has(extension))
  ) {
    return "text";
  }

  return "download";
}
