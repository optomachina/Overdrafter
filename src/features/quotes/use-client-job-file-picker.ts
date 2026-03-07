import { useRef, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  ALLOWED_QUOTE_UPLOAD_EXTENSIONS,
  validateQuoteFiles,
} from "@/features/quotes/file-validation";

type UseClientJobFilePickerOptions = {
  isSignedIn: boolean;
  onRequireAuth?: () => void;
  onFilesSelected: (files: File[]) => Promise<void>;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Unable to create a new job right now.";
}

export function useClientJobFilePicker({
  isSignedIn,
  onRequireAuth,
  onFilesSelected,
}: UseClientJobFilePickerOptions) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = () => {
    if (!isSignedIn) {
      onRequireAuth?.();
      return;
    }

    inputRef.current?.click();
  };

  const handleFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const incomingFiles = Array.from(event.target.files ?? []);

    if (inputRef.current) {
      inputRef.current.value = "";
    }

    if (incomingFiles.length === 0) {
      return;
    }

    const { accepted, errors } = validateQuoteFiles(incomingFiles);
    errors.forEach((error) => toast.error(error));

    if (accepted.length === 0) {
      return;
    }

    try {
      await onFilesSelected(accepted);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return {
    accept: ALLOWED_QUOTE_UPLOAD_EXTENSIONS.join(","),
    inputRef,
    openFilePicker,
    handleFileInputChange,
  };
}
