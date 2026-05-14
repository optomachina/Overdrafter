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
      <DialogContent className="workspace-shell rounded-2xl border-border bg-ws-raised text-foreground">
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
            {description ? <DialogDescription className="text-muted-foreground">{description}</DialogDescription> : null}
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            className="h-10 rounded-[10px] border-border bg-ws-overlay text-foreground placeholder:text-muted-foreground focus-visible:ring-white/20"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-[10px] border-border bg-transparent text-foreground hover:bg-accent"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="rounded-[10px]" disabled={isPending || isSubmitDisabled}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
