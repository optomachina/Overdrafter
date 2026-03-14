import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { REQUESTED_SERVICE_TYPE_OPTIONS } from "@/features/quotes/service-intent";
import { normalizeServiceRequestInputs } from "@/features/quotes/service-requests";
import type { ServiceRequestLineItemInput } from "@/features/quotes/types";

type ServiceRequestPlannerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ServiceRequestLineItemInput[];
  onChange: (next: ServiceRequestLineItemInput[]) => void;
  onConfirm: () => void;
  isSubmitting?: boolean;
};

const DEFAULT_SERVICE_TYPE = REQUESTED_SERVICE_TYPE_OPTIONS[0]?.code ?? "manufacturing_quote";

function moveItem<T>(items: T[], currentIndex: number, delta: -1 | 1): T[] {
  const nextIndex = currentIndex + delta;

  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(currentIndex, 1);
  next.splice(nextIndex, 0, item);
  return next;
}

export function ServiceRequestPlannerDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onConfirm,
  isSubmitting = false,
}: ServiceRequestPlannerDialogProps) {
  const normalizedItems = normalizeServiceRequestInputs(value);

  const updateItems = (next: ServiceRequestLineItemInput[]) => {
    onChange(normalizeServiceRequestInputs(next));
  };

  const addItem = () => {
    const usedTypes = new Set(normalizedItems.map((item) => item.serviceType));
    const nextType =
      REQUESTED_SERVICE_TYPE_OPTIONS.find((option) => !usedTypes.has(option.code))?.code ?? DEFAULT_SERVICE_TYPE;

    updateItems([
      ...normalizedItems,
      {
        serviceType: nextType,
        scope: "job",
        requestedByDate: normalizedItems[0]?.requestedByDate ?? null,
        serviceNotes: normalizedItems[0]?.serviceNotes ?? null,
        detailPayload: {},
      },
    ]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-white/10 bg-[#161616] text-white sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review workpack</DialogTitle>
          <DialogDescription className="text-white/55">
            Confirm the requested services before the draft is created. Quote quantities stay attached only to
            quote-compatible services.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {normalizedItems.map((item, index) => {
            const usedTypes = new Set(
              normalizedItems
                .filter((candidate, candidateIndex) => candidateIndex !== index)
                .map((candidate) => candidate.serviceType),
            );

            return (
              <div key={`${item.serviceType}-${index}`} className="rounded-3xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid flex-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Service</Label>
                      <Select
                        value={item.serviceType}
                        onValueChange={(serviceType) =>
                          updateItems(
                            normalizedItems.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? {
                                    ...candidate,
                                    serviceType,
                                  }
                                : candidate,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="border-white/10 bg-black/20 text-white">
                          <SelectValue placeholder="Select a service" />
                        </SelectTrigger>
                        <SelectContent>
                          {REQUESTED_SERVICE_TYPE_OPTIONS.map((option) => (
                            <SelectItem
                              key={option.code}
                              value={option.code}
                              disabled={usedTypes.has(option.code)}
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Need by</Label>
                      <Input
                        type="date"
                        value={item.requestedByDate ?? ""}
                        onChange={(event) =>
                          updateItems(
                            normalizedItems.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? {
                                    ...candidate,
                                    requestedByDate: event.target.value || null,
                                  }
                                : candidate,
                            ),
                          )
                        }
                        className="border-white/10 bg-black/20 text-white"
                      />
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <Label>Service notes</Label>
                      <Textarea
                        value={item.serviceNotes ?? ""}
                        onChange={(event) =>
                          updateItems(
                            normalizedItems.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? {
                                    ...candidate,
                                    serviceNotes: event.target.value || null,
                                  }
                                : candidate,
                            ),
                          )
                        }
                        className="min-h-[96px] border-white/10 bg-black/20 text-white"
                        placeholder="Optional sequencing, deliverable expectations, or review notes."
                      />
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => updateItems(moveItem(normalizedItems, index, -1))}
                      disabled={index === 0}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => updateItems(moveItem(normalizedItems, index, 1))}
                      disabled={index === normalizedItems.length - 1}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => updateItems(normalizedItems.filter((_, candidateIndex) => candidateIndex !== index))}
                      disabled={normalizedItems.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            className="w-full rounded-full border-dashed border-white/15 bg-transparent text-white hover:bg-white/6"
            onClick={addItem}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add service
          </Button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="border-white/10 bg-transparent text-white hover:bg-white/6"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" className="rounded-full" onClick={onConfirm} disabled={isSubmitting}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
