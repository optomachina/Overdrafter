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

// One SHA-256 digest per staged-file candidate; null means the file could not be read or hashed.
const stagedFileDigests = new WeakMap<File, Promise<string | null>>();

/**
 * The tail of one composer's digest chain. Each digest reads and hashes its file only after the
 * previous digest has settled, so a composer holds at most one whole file in memory for hashing.
 */
type DigestQueue = { tail: Promise<unknown> };

/** Reads and hashes one file; any failure resolves to null, so this promise never rejects. */
async function readStagedFileDigest(file: File): Promise<string | null> {
  try {
    // A Uint8Array view keeps the input acceptable to SubtleCrypto when the buffer comes from another realm.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Queues a file's digest behind the composer's earlier digests; a null result keeps the file. */
function digestStagedFile(file: File, queue: DigestQueue): Promise<string | null> {
  const cached = stagedFileDigests.get(file);
  if (cached !== undefined) {
    return cached;
  }

  // readStagedFileDigest never rejects, so a failed or null digest does not stop later reads.
  const digest = queue.tail.then(() => readStagedFileDigest(file));
  queue.tail = digest;
  stagedFileDigests.set(file, digest);
  return digest;
}

function hasSameMetadata(file: File, candidate: File): boolean {
  return candidate !== file && getStagedFileKey(candidate) === getStagedFileKey(file);
}

/**
 * Removes a colliding file only when another staged file with the same name, size and mtime has
 * the same SHA-256. Metadata alone never drops a file, a file whose digest failed is always kept,
 * and at least one copy always stays because each removal is checked against the current list.
 */
async function removeProvenDuplicates(
  colliding: File[],
  getStaged: () => File[],
  commit: (next: File[]) => void,
  queue: DigestQueue,
): Promise<void> {
  const candidates = new Set<File>(colliding);
  for (const file of colliding) {
    getStaged().filter((candidate) => hasSameMetadata(file, candidate)).forEach((candidate) => candidates.add(candidate));
  }
  const digests = new Map(
    await Promise.all(
      Array.from(candidates, async (candidate) => [candidate, await digestStagedFile(candidate, queue)] as const),
    ),
  );

  const staged = getStaged();
  let next = staged;
  for (const file of colliding) {
    const digest = digests.get(file);
    if (digest === null || digest === undefined || !next.includes(file)) {
      continue;
    }
    if (next.some((candidate) => hasSameMetadata(file, candidate) && digests.get(candidate) === digest)) {
      next = next.filter((candidate) => candidate !== file);
    }
  }

  if (next !== staged) {
    commit(next);
  }
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
    // Synchronous mirror of `files` so duplicate removal after a digest sees the latest list.
    const stagedFilesRef = useRef<File[]>([]);
    const commitStagedFiles = (next: File[]) => {
      stagedFilesRef.current = next;
      setFiles(next);
    };
    // One digest chain per composer, so colliding files are read and hashed one at a time.
    const digestQueueRef = useRef<DigestQueue>({ tail: Promise.resolve() });
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

      // The same File object is a proven duplicate and is dropped at once; the existing chip already
      // shows it. A different file whose name, size and mtime match a staged file is staged
      // immediately, so it is visible and submitted, and is removed only if its digest proves it a copy.
      const current = stagedFilesRef.current;
      const next = [...current];
      const colliding: File[] = [];
      for (const file of accepted) {
        if (next.includes(file)) {
          continue;
        }
        if (next.some((candidate) => hasSameMetadata(file, candidate))) {
          colliding.push(file);
        }
        next.push(file);
      }

      if (next.length !== current.length) {
        commitStagedFiles(next);
      }
      if (colliding.length > 0) {
        await removeProvenDuplicates(
          colliding,
          () => stagedFilesRef.current,
          commitStagedFiles,
          digestQueueRef.current,
        );
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
