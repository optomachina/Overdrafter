import { useTheme } from "next-themes";
import { Copy } from "lucide-react";
import { Toaster as Sonner, toast, type ExternalToast } from "sonner";
import { copyTextToClipboard, createToastClipboardText } from "@/lib/diagnostics";

type ToasterProps = React.ComponentProps<typeof Sonner>;
const PERSISTENT_ERROR_DURATION = Number.POSITIVE_INFINITY;
let persistentErrorToastInstalled = false;

function getToastMessageText(message: unknown) {
  if (typeof message === "string" || typeof message === "number") {
    return String(message);
  }

  return "Error toast triggered.";
}

function renderCopyToastLabel() {
  return (
    <span className="flex items-center justify-center">
      <Copy className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Copy debug details</span>
    </span>
  );
}

function withPersistentErrorOptions(message: unknown, data?: ExternalToast): ExternalToast {
  const nextOptions: ExternalToast = {
    ...data,
    duration: data?.duration ?? PERSISTENT_ERROR_DURATION,
    closeButton: data?.closeButton ?? true,
    dismissible: data?.dismissible ?? true,
  };

  const messageText = getToastMessageText(message);
  const copyAction = {
    label: renderCopyToastLabel(),
    onClick: () => {
      void copyTextToClipboard(createToastClipboardText(messageText))
        .then(() => {
          toast.success("Error details copied.");
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Unable to copy error details.");
        });
    },
  };

  if (!nextOptions.action) {
    nextOptions.action = copyAction;
  } else if (!nextOptions.cancel) {
    nextOptions.cancel = copyAction;
  }

  return nextOptions;
}

function installPersistentErrorToast() {
  if (persistentErrorToastInstalled) {
    return;
  }

  const originalToastError = toast.error.bind(toast);
  toast.error = ((message, data) =>
    originalToastError(message, withPersistentErrorOptions(message, data))) as typeof toast.error;
  persistentErrorToastInstalled = true;
}

installPersistentErrorToast();

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
