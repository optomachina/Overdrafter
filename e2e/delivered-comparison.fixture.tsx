/* eslint-disable react-refresh/only-export-components -- test-only entry point, never hot-reloaded as a module */
/** Synthetic shell around the actual ClientQuoteDecisionPanel; enabled only by e2e/delivered-comparison.config.ts. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientQuoteDecisionPanel } from "../src/components/quotes/ClientQuoteDecisionPanel";
import { makeClientQuoteOption } from "../src/components/quotes/test-option-factory";
import type { QuoteRequestCompletionInput } from "../src/features/quotes/delivered-comparison";
import type { ClientQuoteSelectionOption } from "../src/features/quotes/selection";
import type { VendorName } from "../src/integrations/supabase/types";
import "../src/index.css";

// Monday 2026-10-12 in a UTC calendar keeps every civil date deterministic.
const NOW = new Date("2026-10-12T15:00:00.000Z");

function option(key: string, vendorKey: VendorName, vendorLabel: string, overrides: Partial<ClientQuoteSelectionOption>) {
  return makeClientQuoteOption({
    key, offerId: key, persistedOfferId: key, vendorKey, vendorLabel, supplier: vendorLabel,
    vendorQuoteResultId: `result-${vendorKey}`, leadTimeBusinessDays: null, resolvedDeliveryDate: null,
    laneLabel: key.replaceAll("-", " "), ...overrides,
  });
}

const INITIAL: ClientQuoteSelectionOption[] = [
  option("xometry-express", "xometry", "Xometry", { totalPriceUsd: 300, shipReceiveBy: "2026-10-15" }),
  option("xometry-standard", "xometry", "Xometry", { totalPriceUsd: 150, shipReceiveBy: "2026-10-21" }),
  option("protolabs-overlap", "protolabs", "Protolabs", { totalPriceUsd: 150, shipReceiveBy: "2026-10-21" }),
  option("protolabs-economy", "protolabs", "Protolabs", { totalPriceUsd: 50, shipReceiveBy: "2026-10-30" }),
  option("fictiv-lead", "fictiv", "Fictiv", { totalPriceUsd: 200, leadTimeBusinessDays: 3 }),
  option("sendcutsend-unknown", "sendcutsend", "SendCutSend", { totalPriceUsd: 40 }),
  // Overseas result: concealed by the US-only scope and never counted.
  option("rapiddirect-overseas", "rapiddirect", "RapidDirect", { totalPriceUsd: 20, shipReceiveBy: "2026-10-14", geographicOrigin: "foreign", domesticStatus: "foreign" }),
];
const ARRIVAL = option("quickparts-arriving", "quickparts", "Quickparts", { totalPriceUsd: 120, shipReceiveBy: "2026-10-19" });
const REQUESTED: VendorName[] = ["xometry", "protolabs", "fictiv", "sendcutsend", "rapiddirect", "quickparts"];

function completion(arrived: boolean): QuoteRequestCompletionInput {
  return {
    request: { id: "fixture-request", status: arrived ? "received" : "requesting", requestedVendors: REQUESTED },
    run: { id: "fixture-run", quoteRequestId: "fixture-request" },
    vendorResults: REQUESTED.map((vendor) => ({
      id: `result-${vendor}`,
      vendor,
      quoteRunId: "fixture-run",
      status: vendor === "quickparts" && !arrived ? "running" : "instant_quote_received",
    })),
  };
}

declare global {
  interface Window { __ovd571Arrive?: () => void }
}

function Harness() {
  const [options, setOptions] = useState(INITIAL);
  const [arrived, setArrived] = useState(false);
  const [selected, setSelected] = useState<ClientQuoteSelectionOption | null>(null);
  useEffect(() => {
    window.__ovd571Arrive = () => {
      setOptions((current) => [ARRIVAL, ...current]);
      setArrived(true);
    };
  }, []);
  return (
    <main className="mx-auto max-w-6xl p-2 sm:p-6">
      <div style={{ height: 240 }} aria-hidden="true" />
      <ClientQuoteDecisionPanel
        title="Quote comparison"
        options={options}
        selectedOption={selected}
        onSelect={setSelected}
        requestedByDate={null}
        deadline={{ date: "2026-10-22", state: "confirmed" }}
        requestCompletion={completion(arrived)}
        activePreset="cheapest_domestic"
        now={NOW}
        timeZone="UTC"
      />
      <div style={{ height: 1200 }} aria-hidden="true" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
