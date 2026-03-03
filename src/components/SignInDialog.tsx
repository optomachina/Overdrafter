import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: "sign-in" | "sign-up";
}

export function SignInDialog({
  open,
  onOpenChange,
  initialMode = "sign-in",
}: SignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/28 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed inset-x-4 bottom-4 z-50 outline-none sm:inset-x-auto sm:right-6 sm:top-20 sm:w-[380px]">
          <DialogPrimitive.Title className="sr-only">
            {initialMode === "sign-up" ? "Create account" : "Log in"}
          </DialogPrimitive.Title>
          <AuthPanel initialMode={initialMode} onSuccess={() => onOpenChange(false)} />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
