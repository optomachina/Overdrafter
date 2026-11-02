import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STATUS_TONE } from "@/components/quotes/status-tone";
import {
  confirmSourcingDestination,
  fetchSourcingDestination,
  isSourcingAddressComplete,
  missingSourcingAddressFields,
  updateOrganizationAddresses,
  type SourcingDestination,
} from "@/features/quotes/api/organizations-api";
import { getUserFacingErrorMessage } from "@/lib/error-message";

type Address = SourcingDestination["address"];

type QuoteShippingAddressPanelProps = {
  organizationId: string;
  providerLabel: string;
  /** Called once the server has confirmed the address; the caller re-runs its scope check. */
  onConfirmed: () => void | Promise<void>;
};

const FIELDS: { key: keyof Address; label: string; autoComplete: string }[] = [
  { key: "street", label: "Street", autoComplete: "street-address" },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "region", label: "State", autoComplete: "address-level1" },
  { key: "postalCode", label: "ZIP", autoComplete: "postal-code" },
  { key: "country", label: "Country", autoComplete: "country" },
];

function normalize(address: Address): Address {
  const value = (field: string | null) => field?.trim() || null;
  return {
    street: value(address.street),
    city: value(address.city),
    region: value(address.region),
    postalCode: value(address.postalCode),
    country: value(address.country),
  };
}

function formatAddress(address: Address): string {
  return [address.street, address.city, [address.region, address.postalCode].filter(Boolean).join(" "), address.country]
    .filter(Boolean)
    .join(", ");
}

/**
 * OVD-1068: lets the customer resolve a missing confirmed shipping address inside the quote
 * confirmation dialog. Only the server read-back address is ever confirmed, never the local draft.
 */
export function QuoteShippingAddressPanel({ organizationId, providerLabel, onConfirmed }: QuoteShippingAddressPanelProps) {
  const [destination, setDestination] = useState<SourcingDestination | null>(null);
  const [draft, setDraft] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDestination(null);
    setDraft(null);
    setError(null);
    fetchSourcingDestination(organizationId)
      .then((loaded) => {
        if (cancelled) return;
        setDestination(loaded);
        setDraft({ ...loaded.address, country: loaded.address.country ?? "US" });
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your organization's shipping address.");
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const savedComplete = destination !== null && isSourcingAddressComplete(destination.address);
  const draftComplete = draft !== null && isSourcingAddressComplete(normalize(draft));

  async function confirm(address: Address) {
    await confirmSourcingDestination(organizationId, address);
    await onConfirmed();
  }

  async function reload() {
    try {
      const loaded = await fetchSourcingDestination(organizationId);
      setDestination(loaded);
      setDraft({ ...loaded.address, country: loaded.address.country ?? "US" });
    } catch {
      setDestination(null);
    }
  }

  async function handleConfirmSaved() {
    if (!destination || !savedComplete) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await confirm(destination.address);
    } catch (confirmError) {
      setError(getUserFacingErrorMessage(confirmError, "Could not confirm the shipping address."));
      await reload();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveAndConfirm() {
    if (!draft || !draftComplete) return;
    const entered = normalize(draft);
    setIsSubmitting(true);
    setError(null);
    try {
      await updateOrganizationAddresses(organizationId, {
        shippingSameAsBilling: false,
        shippingStreet: entered.street,
        shippingCity: entered.city,
        shippingState: entered.region,
        shippingZip: entered.postalCode,
        shippingCountry: entered.country,
      });
      // Confirm what the server now holds, not the draft.
      const saved = await fetchSourcingDestination(organizationId);
      setDestination(saved);
      await confirm(saved.address);
    } catch (saveError) {
      setError(getUserFacingErrorMessage(saveError, "Could not save the shipping address."));
      await reload();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section aria-label="Quote shipping destination" className="border-b border-paper-hairline px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-paper-ink">
        <MapPin className="h-4 w-4" aria-hidden="true" />
        Quote shipping destination
      </p>
      <p className="mt-1 leading-5 text-paper-muted">
        {providerLabel} quotes need the address parts would ship to. Confirming it here saves it for your organization.
      </p>

      {destination === null && error === null ? <p className="mt-2 text-paper-muted">Loading shipping address…</p> : null}

      {destination !== null && savedComplete ? (
        <div className="mt-3">
          <p className="text-paper-ink">{formatAddress(destination.address)}</p>
          <Button
            type="button"
            size="sm"
            className="mt-3 rounded-[2px]"
            disabled={isSubmitting}
            onClick={() => void handleConfirmSaved()}
          >
            {isSubmitting ? "Confirming…" : "Confirm shipping address"}
          </Button>
        </div>
      ) : null}

      {destination !== null && !savedComplete && draft !== null ? (
        <div className="mt-3">
          <p className="text-paper-ink">Add {missingSourcingAddressFields(destination.address).join(", ")} before confirming.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {FIELDS.map(({ key, label, autoComplete }) => {
              const id = `quote-shipping-${key}`;
              return (
                <div key={key} className={key === "street" ? "sm:col-span-2" : undefined}>
                  <Label htmlFor={id} className="text-xs text-paper-muted">
                    {label}
                  </Label>
                  <Input
                    id={id}
                    autoComplete={autoComplete}
                    className="mt-1 h-9 rounded-[2px]"
                    value={draft[key] ?? ""}
                    disabled={isSubmitting}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            size="sm"
            className="mt-3 rounded-[2px]"
            disabled={isSubmitting || !draftComplete}
            onClick={() => void handleSaveAndConfirm()}
          >
            {isSubmitting ? "Saving…" : "Save and confirm address"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className={`mt-2 text-sm ${STATUS_TONE.error}`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
