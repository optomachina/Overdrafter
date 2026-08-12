import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal } from "@/components/ui/dialog";

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: "sign-in" | "sign-up" | "forgot-password";
  redirectPath?: string;
}

export function SignInDialog({
  open,
  onOpenChange,
  initialMode = "sign-in",
  redirectPath = "/",
}: SignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-background backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-[380px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none">
          <DialogPrimitive.Title className="sr-only">
            {initialMode === "sign-up" ? "Create account" : initialMode === "forgot-password" ? "Reset password" : "Log in"}
          </DialogPrimitive.Title>
          <DialogDescription className="sr-only">
            {initialMode === "sign-up"
              ? "Create an OverDrafter account to access uploads, quote reviews, and published packages."
              : initialMode === "forgot-password"
                ? "Enter your email address to receive a password reset link."
                : "Log in to OverDrafter to access uploads, quote reviews, and published packages."}
          </DialogDescription>
          <AuthPanel
            initialMode={initialMode}
            redirectPath={redirectPath}
            onSuccess={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
