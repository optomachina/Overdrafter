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
        card: "rounded-2xl border border-white/8 bg-white/5 px-4 py-3",
        helper: "text-xs text-white/45",
        select: "border-white/10 bg-black/20 text-white",
        textarea: "min-h-[96px] border-white/10 bg-black/20 text-white",
      }
    : {
        card: "rounded-2xl border border-white/10 bg-black/20 px-4 py-3",
        helper: "text-xs text-white/45",
        select: "border-white/10 bg-black/20 text-white",
        textarea: "min-h-[96px] border-white/10 bg-black/20 text-white",
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
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Requested services</Label>
        <div className="grid gap-3 md:grid-cols-2">
          {REQUESTED_SERVICE_TYPE_OPTIONS.map((option) => (
            <label key={option.code} className={styles.card}>
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={requestedServiceKinds.includes(option.code)}
                  disabled={disabled}
                  onCheckedChange={(checked) => handleToggle(option.code, checked === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-white">{option.label}</div>
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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
