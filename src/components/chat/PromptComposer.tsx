import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { ArrowUp, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { FileChip } from "@/components/FileChip";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ALLOWED_QUOTE_UPLOAD_EXTENSIONS,
  validateQuoteFiles,
} from "@/features/quotes/file-validation";
import { WorkspaceNotReadyError } from "@/lib/workspace-errors";
import {
  getFoundingBetaStatusFromRefetch,
  getFoundingBetaUploadMessage,
  isFoundingBetaEnforcementError,
} from "@/features/quotes/founding-beta-access";
import { useFoundingBetaAccess } from "@/features/quotes/use-founding-beta-access";

export type PromptComposerHandle = {
  focus: () => void;
};

type PromptComposerProps = {
  isSignedIn: boolean;
  isVerifiedAuth: boolean;
  organizationId?: string;
  userId?: string;
  placeholder?: string;
  onRequireAuth?: () => void;
  onSubmit: (input: { prompt: string; files: File[]; clear: () => void }) => Promise<void>;
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

  return "Unable to submit this part right now.";
}

function getStagedFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error(`Unable to read ${file.name}.`));
    reader.readAsArrayBuffer(file);
  });
}

// Resolved SHA-256 digests of staged-file candidates; null means the file could not be read or hashed.
const stagedFileDigests = new WeakMap<File, string | null>();
const pendingStagedFileDigests = new WeakMap<File, Promise<string | null>>();

/** Hashes a file off the input path; a failure resolves to null so the caller keeps the file. */
function digestStagedFile(file: File): Promise<string | null> {
  const pending = pendingStagedFileDigests.get(file);
  if (pending) {
    return pending;
  }

  const digest = (async () => {
    try {
      const hash = await crypto.subtle.digest("SHA-256", await readFileBytes(file));
      return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  })().then((value) => {
    stagedFileDigests.set(file, value);
    return value;
  });
  pendingStagedFileDigests.set(file, digest);
  return digest;
}

type StagingDecision =
  | { kind: "duplicate" }
  | { kind: "distinct" }
  | { kind: "needs-digest"; files: File[] };

/**
 * A file is a duplicate only when it is the same File object as a staged one, or when a staged
 * file with the same name, size and mtime has the same SHA-256. Metadata alone never drops a
 * file, and a file whose digest failed is always kept.
 */
function decideStaging(file: File, staged: File[]): StagingDecision {
  if (staged.includes(file)) {
    return { kind: "duplicate" };
  }

  const key = getStagedFileKey(file);
  const metadataMatches = staged.filter((candidate) => getStagedFileKey(candidate) === key);
  if (metadataMatches.length === 0) {
    return { kind: "distinct" };
  }

  const unresolved = [file, ...metadataMatches].filter((candidate) => !stagedFileDigests.has(candidate));
  if (unresolved.length > 0) {
    return { kind: "needs-digest", files: unresolved };
  }

  const digest = stagedFileDigests.get(file);
  if (digest === null || digest === undefined) {
    return { kind: "distinct" };
  }

  return metadataMatches.some((candidate) => stagedFileDigests.get(candidate) === digest)
    ? { kind: "duplicate" }
    : { kind: "distinct" };
}

export const PromptComposer = forwardRef<PromptComposerHandle, PromptComposerProps>(
  ({
    isSignedIn,
    isVerifiedAuth,
    organizationId,
    userId,
    placeholder = "Ask anything",
    onRequireAuth,
    onSubmit,
  }, ref) => {
    const MIN_TEXTAREA_HEIGHT = 40;
    const MAX_TEXTAREA_HEIGHT = 200;
    const [prompt, setPrompt] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // isSubmitting only disables the controls after a render, so these refs stop a second
    // Enter, Send or Upload click that arrives while the access refetch is still pending.
    const submitGuardRef = useRef(false);
    const pickGuardRef = useRef(false);
    // Synchronous mirror of `files` so staging that resumes after a digest sees the latest list.
    const stagedFilesRef = useRef<File[]>([]);
    const commitStagedFiles = (next: File[]) => {
      stagedFilesRef.current = next;
      setFiles(next);
    };
    const betaAccess = useFoundingBetaAccess({
      organizationId,
      userId,
      enabled: isSignedIn && isVerifiedAuth,
    });

    const requireWriteAccess = async () => {
      if (!isVerifiedAuth) {
        toast.error("Please verify your email before creating a part.");
        return false;
      }
      const refreshed = await betaAccess.refetch();
      const refreshedStatus = getFoundingBetaStatusFromRefetch(refreshed);
      if (refreshedStatus === "eligible") {
        return true;
      }

      toast.error(getFoundingBetaUploadMessage(refreshedStatus));
      return false;
    };

    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
    }));

    const adjustHeight = () => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT), MIN_TEXTAREA_HEIGHT)}px`;
    };

    useEffect(() => {
      adjustHeight();
    }, [prompt]);

    const addFiles = async (incomingFiles: File[]) => {
      if (!(await requireWriteAccess())) {
        return;
      }
      const { accepted, errors } = validateQuoteFiles(incomingFiles);

      errors.forEach((error) => toast.error(error));

      // The existing chip already shows a repeated file, so a proven duplicate is dropped silently.
      // Files whose metadata matches a staged file wait for a content digest; everything else
      // stages synchronously, so concurrent selections see each other through stagedFilesRef.
      let pending = accepted;
      while (pending.length > 0) {
        const next = [...stagedFilesRef.current];
        const waiting: File[] = [];
        const toDigest = new Set<File>();
        for (const file of pending) {
          const decision = decideStaging(file, next);
          if (decision.kind === "distinct") {
            next.push(file);
          } else if (decision.kind === "needs-digest") {
            waiting.push(file);
            decision.files.forEach((candidate) => toDigest.add(candidate));
          }
        }

        if (next.length !== stagedFilesRef.current.length) {
          commitStagedFiles(next);
        }
        if (toDigest.size > 0) {
          await Promise.all(Array.from(toDigest, digestStagedFile));
        }
        pending = waiting;
      }
    };

    const clear = () => {
      setPrompt("");
      commitStagedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
      const incomingFiles = Array.from(event.target.files ?? []);
      void addFiles(incomingFiles);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleSubmit = async () => {
      if (!prompt.trim() && files.length === 0) {
        toast.error("Please enter details or upload files.");
        return;
      }

      if (submitGuardRef.current) {
        return;
      }
      submitGuardRef.current = true;

      try {
        if (!isSignedIn) {
          onRequireAuth?.();
          return;
        }
        if (!(await requireWriteAccess())) {
          return;
        }

        setIsSubmitting(true);

        try {
          await onSubmit({ prompt, files, clear });
        } catch (error) {
          if (isFoundingBetaEnforcementError(error)) {
            const refreshed = await betaAccess.refetch();
            const refreshedStatus = getFoundingBetaStatusFromRefetch(refreshed);
            toast.error(getFoundingBetaUploadMessage(refreshedStatus));
          } else if (error instanceof WorkspaceNotReadyError) {
            toast.error(getErrorMessage(error), { id: error.toastId });
          } else {
            toast.error(getErrorMessage(error));
          }
        }
      } finally {
        submitGuardRef.current = false;
        setIsSubmitting(false);
      }
    };

    return (
      <div className="w-full max-w-[640px]">
        {files.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2 px-2">
            {files.map((file, index) => (
              <FileChip
                key={`${file.name}-${index}`}
                fileName={file.name}
                onRemove={() => commitStagedFiles(
                  stagedFilesRef.current.filter((_, currentIndex) => currentIndex !== index),
                )}
              />
            ))}
          </div>
        ) : null}

        <div className="rounded-[28px] border border-border bg-ws-raised shadow-[0_8px_40px_rgba(0,0,0,0.22)]">
          <div className="flex items-end gap-2 p-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  aria-label="Upload files"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full text-foreground/80 hover:bg-accent hover:text-foreground"
                  onClick={async () => {
                    if (!isSignedIn) {
                      onRequireAuth?.();
                      return;
                    }

                    if (pickGuardRef.current) {
                      return;
                    }
                    pickGuardRef.current = true;

                    try {
                      if (!(await requireWriteAccess())) {
                        return;
                      }

                      fileInputRef.current?.click();
                    } finally {
                      pickGuardRef.current = false;
                    }
                  }}
                  disabled={isSubmitting}
                >
                  <Plus className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Upload files</TooltipContent>
            </Tooltip>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ALLOWED_QUOTE_UPLOAD_EXTENSIONS.join(",")}
              onChange={handleFileUpload}
              className="hidden"
              aria-label="Upload files"
            />

            <textarea
              id="chat-composer"
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                const pastedFiles = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => Boolean(file));

                if (pastedFiles.length > 0) {
                  if (!isSignedIn) {
                    onRequireAuth?.();
                    return;
                  }
                  void addFiles(pastedFiles);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              rows={1}
              placeholder={placeholder}
              disabled={isSubmitting}
              className="h-10 max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
            />

            <Button
              type="button"
              aria-label="Submit"
              size="icon"
              className="h-10 w-10 rounded-full bg-primary text-primary-foreground hover:bg-accent disabled:bg-accent disabled:text-muted-foreground"
              disabled={isSubmitting || (!prompt.trim() && files.length === 0)}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

PromptComposer.displayName = "PromptComposer";
