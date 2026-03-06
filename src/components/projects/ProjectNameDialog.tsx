import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type ProjectNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  value: string;
  onValueChange: (value: string) => void;
  submitLabel: string;
  isPending?: boolean;
  isSubmitDisabled?: boolean;
  placeholder?: string;
  onSubmit: () => void | Promise<void>;
};

export function ProjectNameDialog({
  open,
  onOpenChange,
  title,
  description,
  value,
  onValueChange,
  submitLabel,
  isPending = false,
  isSubmitDisabled = false,
  placeholder = "Project name",
  onSubmit,
}: ProjectNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();

            if (isPending || isSubmitDisabled) {
              return;
            }

            void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription className="text-white/55">{description}</DialogDescription> : null}
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            className="border-white/10 bg-[#2a2a2a] text-white placeholder:text-white/35"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="rounded-full" disabled={isPending || isSubmitDisabled}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
