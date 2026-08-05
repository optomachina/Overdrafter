import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  REQUESTED_SERVICE_TYPE_OPTIONS,
  normalizePrimaryServiceKind,
  normalizeRequestedServiceKinds,
  type RequestedServiceIntent,
  type RequestedServiceKind,
} from "@/features/quotes/service-intent";

type RequestServiceIntentFieldsProps = {
  value: RequestedServiceIntent;
  onChange: (next: RequestedServiceIntent) => void;
  disabled?: boolean;
  tone?: "client" | "internal";
};

function getToneClasses(tone: "client" | "internal") {
  return tone === "internal"
    ? {
        card: "min-w-0 rounded-2xl border border-border bg-accent px-4 py-3",
        grid: "grid min-w-0 gap-3 md:grid-cols-2",
        helper: "break-words text-xs text-muted-foreground",
        select: "min-w-0 border-border bg-muted text-foreground",
        textarea: "min-h-[96px] min-w-0 border-border bg-muted text-foreground",
      }
    : {
        card: "min-w-0 rounded-2xl border border-border bg-muted px-4 py-3",
        grid: "grid min-w-0 grid-cols-1 gap-3",
        helper: "break-words text-xs text-muted-foreground",
        select: "min-w-0 border-border bg-muted text-foreground",
        textarea: "min-h-[96px] min-w-0 border-border bg-muted text-foreground",
      };
}

export function RequestServiceIntentFields({
  value,
  onChange,
  disabled = false,
  tone = "client",
}: RequestServiceIntentFieldsProps) {
  const styles = getToneClasses(tone);
  const requestedServiceKinds = normalizeRequestedServiceKinds(
    value.requestedServiceKinds,
    value.primaryServiceKind,
  );
  const primaryServiceKind = normalizePrimaryServiceKind(
    requestedServiceKinds,
    value.primaryServiceKind,
  );

  const handleToggle = (serviceKind: RequestedServiceKind, checked: boolean) => {
    const nextRequestedServiceKinds = checked
      ? normalizeRequestedServiceKinds([...requestedServiceKinds, serviceKind], primaryServiceKind)
      : normalizeRequestedServiceKinds(
          requestedServiceKinds.filter((currentServiceKind) => currentServiceKind !== serviceKind),
          serviceKind === primaryServiceKind ? null : primaryServiceKind,
        );

    onChange({
      requestedServiceKinds: nextRequestedServiceKinds,
      primaryServiceKind: normalizePrimaryServiceKind(
        nextRequestedServiceKinds,
        serviceKind === primaryServiceKind && !checked ? null : primaryServiceKind,
      ),
      serviceNotes: value.serviceNotes,
    });
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-2">
        <Label>Requested services</Label>
        <div className={styles.grid}>
          {REQUESTED_SERVICE_TYPE_OPTIONS.map((option) => (
            <label key={option.code} className={styles.card}>
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={requestedServiceKinds.includes(option.code)}
                  disabled={disabled}
                  onCheckedChange={(checked) => handleToggle(option.code, checked === true)}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground">{option.label}</div>
                  <p className={styles.helper}>{option.description}</p>
                </div>
              </div>
            </label>
          ))}
        </div>
        <p className={styles.helper}>
          Quote quantities stay active only when Manufacturing quote or Sourcing only is selected.
        </p>
      </div>

      <div className="min-w-0 space-y-2">
        <Label>Primary service</Label>
        <Select
          value={primaryServiceKind}
          onValueChange={(nextValue) =>
            onChange({
              requestedServiceKinds: normalizeRequestedServiceKinds(requestedServiceKinds, nextValue),
              primaryServiceKind: normalizePrimaryServiceKind(requestedServiceKinds, nextValue),
              serviceNotes: value.serviceNotes,
            })
          }
          disabled={disabled}
        >
          <SelectTrigger className={styles.select}>
            <SelectValue placeholder="Select a primary service" />
          </SelectTrigger>
          <SelectContent>
            {requestedServiceKinds.map((serviceKind) => {
              const option = REQUESTED_SERVICE_TYPE_OPTIONS.find((candidate) => candidate.code === serviceKind);

              if (!option) {
                return null;
              }

              return (
                <SelectItem key={serviceKind} value={serviceKind}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-0 space-y-2">
        <Label htmlFor={`service-notes-${tone}`}>Service notes</Label>
        <Textarea
          id={`service-notes-${tone}`}
          value={value.serviceNotes ?? ""}
          onChange={(event) =>
            onChange({
              requestedServiceKinds,
              primaryServiceKind,
              serviceNotes: event.target.value || null,
            })
          }
          className={styles.textarea}
          disabled={disabled}
          placeholder="Optional service sequencing, deliverable expectations, or review notes."
        />
      </div>
    </div>
  );
}
