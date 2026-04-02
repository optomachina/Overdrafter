import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PROCUREMENT_BILLING_OPTIONS,
  PROCUREMENT_SHIPPING_OPTIONS,
  summarizeProcurementHandoff,
  type ProcurementBillingOption,
  type ProcurementHandoffState,
  type ProcurementShippingOption,
} from "@/features/quotes/procurement-handoff";
import { cn } from "@/lib/utils";

type ProcurementHandoffPanelProps = {
  scopeLabel: string;
  value: ProcurementHandoffState;
  onChange: (next: ProcurementHandoffState) => void;
};

export function ProcurementHandoffPanel({
  scopeLabel,
  value,
  onChange,
}: ProcurementHandoffPanelProps) {
  const summary = summarizeProcurementHandoff(value);

  function updateField<Key extends keyof ProcurementHandoffState>(
    key: Key,
    nextValue: ProcurementHandoffState[Key],
  ) {
    onChange({
      ...value,
      [key]: nextValue,
    });
  }

  return (
    <section className="rounded-[26px] border border-white/8 bg-ws-card p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Procurement handoff</p>
          <h2 className="mt-2 text-xl font-semibold text-white">Capture the details needed for manual follow-up</h2>
          <p className="mt-2 text-sm text-white/55">
            This {scopeLabel} review captures shipping, billing, and PO context for OverDrafter follow-up. It does not place an order or collect payment inside the app.
          </p>
        </div>
        <div
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium",
            summary.ready
              ? "border-emerald-500/25 bg-emerald-500/12 text-emerald-100"
              : "border-amber-500/25 bg-amber-500/12 text-amber-100",
          )}
        >
          {summary.ready ? "Ready for follow-up" : `${summary.missingFields.length} details still needed`}
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.95fr]">
        <div className="space-y-5">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Shipping plan</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {PROCUREMENT_SHIPPING_OPTIONS.map((option) => {
                const isSelected = value.shippingPlan === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isSelected}
                    className={cn(
                      "rounded-2xl border px-4 py-4 text-left transition-colors",
                      isSelected
                        ? "border-white/25 bg-white/12 text-white"
                        : "border-white/8 bg-black/20 text-white/70 hover:bg-white/6",
                    )}
                    onClick={() => updateField("shippingPlan", option.value as ProcurementShippingOption)}
                  >
                    <p className="text-sm font-semibold">{option.label}</p>
                    <p className={cn("mt-2 text-sm", isSelected ? "text-white/70" : "text-white/55")}>
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Billing path</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {PROCUREMENT_BILLING_OPTIONS.map((option) => {
                const isSelected = value.billingPlan === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isSelected}
                    className={cn(
                      "rounded-2xl border px-4 py-4 text-left transition-colors",
                      isSelected
                        ? "border-white/25 bg-white/12 text-white"
                        : "border-white/8 bg-black/20 text-white/70 hover:bg-white/6",
                    )}
                    onClick={() => updateField("billingPlan", option.value as ProcurementBillingOption)}
                  >
                    <p className="text-sm font-semibold">{option.label}</p>
                    <p className={cn("mt-2 text-sm", isSelected ? "text-white/70" : "text-white/55")}>
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm text-white/70">Ship-to contact</span>
              <Input
                value={value.shipToContact}
                onChange={(event) => updateField("shipToContact", event.target.value)}
                placeholder="Receiving contact or team"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-white/70">Ship-to location</span>
              <Input
                value={value.shipToLocation}
                onChange={(event) => updateField("shipToLocation", event.target.value)}
                placeholder="City, state, or facility"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-white/70">Billing contact name</span>
              <Input
                value={value.billingContactName}
                onChange={(event) => updateField("billingContactName", event.target.value)}
                placeholder="Name for procurement follow-up"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-white/70">Billing contact email</span>
              <Input
                type="email"
                value={value.billingContactEmail}
                onChange={(event) => updateField("billingContactEmail", event.target.value)}
                placeholder="buyer@company.com"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-[0.9fr_1.1fr]">
            <label className="space-y-2">
              <span className="text-sm text-white/70">PO reference</span>
              <Input
                value={value.poReference}
                onChange={(event) => updateField("poReference", event.target.value)}
                placeholder="PO number or internal reference"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-white/70">Special instructions</span>
              <Textarea
                value={value.specialInstructions}
                onChange={(event) => updateField("specialInstructions", event.target.value)}
                placeholder="Packaging notes, carrier instructions, approval checkpoints, or handoff context."
                className="min-h-[110px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </label>
          </div>
        </div>

        <div className="rounded-[22px] border border-white/8 bg-black/20 p-5">
          <div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Handoff summary</p>
              <p className="mt-2 text-lg font-semibold text-white">
                {summary.ready ? "Ready for OverDrafter follow-up" : "More detail is needed before release"}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3 text-sm text-white/70">
            <SummaryRow label="Shipping" value={summary.shippingLabel} />
            <SummaryRow label="Ship to" value={summary.shipToSummary} />
            <SummaryRow label="Billing" value={summary.billingLabel} />
            <SummaryRow label="Billing contact" value={summary.billingContactSummary} />
            <SummaryRow label="PO" value={summary.poSummary} />
            <SummaryRow label="Notes" value={summary.instructionsSummary} />
          </div>

          {summary.missingFields.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-amber-100/80">Still needed</p>
              <ul className="mt-3 space-y-2 text-sm text-amber-50">
                {summary.missingFields.map((field) => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-50">
              OverDrafter can use this handoff to coordinate shipping, billing, and PO follow-up outside the app.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="mt-2 text-sm text-white/80">{value}</p>
    </div>
  );
}
