import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";

type LogoutConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  emailAddress?: string | null;
  isPending?: boolean;
};

export function LogoutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  emailAddress,
  isPending = false,
}: LogoutConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/62 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-2rem),31.6rem)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-white/[0.08] bg-[#222225] px-[2.7rem] pb-[2.5rem] pt-[2.65rem] text-white shadow-[0_28px_100px_rgba(0,0,0,0.52)] outline-none">
          <div className="flex flex-col items-center text-center">
            <DialogTitle className="max-w-[15.6rem] text-center text-[1.88rem] font-semibold leading-[1.14] tracking-[-0.04em] text-white">
              Are you sure you want to log out?
            </DialogTitle>
            <DialogDescription className="sr-only">
              Confirm logout to end your current session, or click outside the dialog or cancel to stay signed in.
            </DialogDescription>
            <p className="mt-[1.15rem] max-w-[18rem] text-center text-[0.98rem] font-medium leading-[1.7] text-white/88">
              <span>Log out of Overdrafter as</span>
              <br />
              <span>{emailAddress ?? "your account"}?</span>
            </p>
            <div className="mt-[1.6rem] flex w-full flex-col gap-[0.95rem]">
              <button
                type="button"
                className="flex h-[50px] w-full items-center justify-center rounded-full bg-white px-6 text-[0.95rem] font-medium text-black transition hover:bg-white/94 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isPending}
                onClick={() => void onConfirm()}
              >
                {isPending ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : "Log out"}
              </button>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  className="flex h-[50px] w-full items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] px-6 text-[0.95rem] font-medium text-white transition hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                  disabled={isPending}
                >
                  Cancel
                </button>
              </DialogPrimitive.Close>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
