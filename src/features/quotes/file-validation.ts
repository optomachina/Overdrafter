export const ALLOWED_QUOTE_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".step",
  ".stp",
  ".igs",
  ".iges",
  ".sldprt",
  ".prt",
  ".sldasm",
  ".asm",
  ".x_t",
  ".xt",
] as const;

export const MAX_QUOTE_UPLOAD_BYTES = 200 * 1024 * 1024;

export function validateQuoteFiles(files: File[]) {
  const accepted: File[] = [];
  const errors: string[] = [];

  files.forEach((file) => {
    const extension = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;

    if (!ALLOWED_QUOTE_UPLOAD_EXTENSIONS.includes(extension as (typeof ALLOWED_QUOTE_UPLOAD_EXTENSIONS)[number])) {
      errors.push(`${file.name} is not a supported CNC upload type.`);
      return;
    }

    if (file.size > MAX_QUOTE_UPLOAD_BYTES) {
      errors.push(`${file.name} exceeds the 200 MB file limit.`);
      return;
    }

    accepted.push(file);
  });

  return { accepted, errors };
}

export function buildDraftTitleFromPrompt(prompt: string, files: File[]) {
  const trimmedPrompt = prompt.trim();

  if (trimmedPrompt.length > 0) {
    return trimmedPrompt.split("\n")[0].slice(0, 120);
  }

  const firstFile = files[0];
  if (firstFile) {
    return firstFile.name.replace(/\.[^.]+$/, "");
  }

  return "Untitled part";
}
