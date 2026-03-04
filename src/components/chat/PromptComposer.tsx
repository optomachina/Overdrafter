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

export type PromptComposerHandle = {
  focus: () => void;
};

type PromptComposerProps = {
  isSignedIn: boolean;
  placeholder?: string;
  onRequireAuth?: () => void;
  onSubmit: (input: { prompt: string; files: File[]; clear: () => void }) => Promise<void>;
};

export const PromptComposer = forwardRef<PromptComposerHandle, PromptComposerProps>(
  ({ isSignedIn, placeholder = "Ask anything", onRequireAuth, onSubmit }, ref) => {
    const [prompt, setPrompt] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    };

    useEffect(() => {
      adjustHeight();
    }, [prompt]);

    const addFiles = (incomingFiles: File[]) => {
      const { accepted, errors } = validateQuoteFiles(incomingFiles);

      errors.forEach((error) => toast.error(error));
      if (accepted.length > 0) {
        setFiles((current) => [...current, ...accepted]);
      }
    };

    const clear = () => {
      setPrompt("");
      setFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
      const incomingFiles = Array.from(event.target.files ?? []);
      addFiles(incomingFiles);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleSubmit = async () => {
      if (!prompt.trim() && files.length === 0) {
        toast.error("Please enter details or upload files.");
        return;
      }

      if (!isSignedIn) {
        onRequireAuth?.();
        return;
      }

      setIsSubmitting(true);

      try {
        await onSubmit({ prompt, files, clear });
      } finally {
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
                onRemove={() => setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}
              />
            ))}
          </div>
        ) : null}

        <div className="rounded-[28px] border border-white/8 bg-[#303030] shadow-[0_8px_40px_rgba(0,0,0,0.22)]">
          <div className="flex items-end gap-2 p-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full text-white/75 hover:bg-white/8 hover:text-white"
                  onClick={() => {
                    if (!isSignedIn) {
                      onRequireAuth?.();
                      return;
                    }

                    fileInputRef.current?.click();
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
                  addFiles(pastedFiles);
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
              className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-white outline-none placeholder:text-white/45"
            />

            <Button
              type="button"
              size="icon"
              className="h-10 w-10 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/20 disabled:text-white/45"
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
