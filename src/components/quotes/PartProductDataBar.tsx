import { formatTolerance, formatTextValue } from "@/features/quotes/format-part-fields";
import { requestedServicesSupportQuoteFields } from "@/features/quotes/service-intent";
import type { ClientPartRequestUpdateInput, DrawingExtractionData, JobPartSummary, PartAggregate } from "@/features/quotes/types";

type PartProductDataBarProps = {
  part: PartAggregate | null | undefined;
  summary: JobPartSummary | null | undefined;
  extraction: DrawingExtractionData | null | undefined;
  draft: ClientPartRequestUpdateInput | null;
};

type DataField = {
  label: string;
  value: string;
};

function buildDataFields(input: PartProductDataBarProps): DataField[] {
  const { part, summary, extraction, draft } = input;
  const showQuoteFields = requestedServicesSupportQuoteFields(
    draft?.requestedServiceKinds ?? summary?.requestedServiceKinds,
  );

  return [
    {
      label: "Material",
      value:
        draft?.material?.trim() ||
        part?.clientRequirement?.material ||
        part?.approvedRequirement?.material ||
        extraction?.material.normalized ||
        extraction?.material.raw ||
        "—",
    },
    {
      label: "Finish",
      value:
        draft?.finish?.trim() ||
        part?.clientRequirement?.finish ||
        part?.approvedRequirement?.finish ||
        extraction?.quoteFinish ||
        extraction?.finish.normalized ||
        extraction?.finish.raw ||
        "—",
    },
    {
      label: "Tolerance",
      value: formatTolerance(
        draft?.tightestToleranceInch ??
          part?.clientRequirement?.tightestToleranceInch ??
          part?.approvedRequirement?.tightest_tolerance_inch ??
          extraction?.tightestTolerance.valueInch ??
          null,
      ),
    },
    {
      label: "Quantity",
      value:
        showQuoteFields && draft?.requestedQuoteQuantities.length
          ? draft.requestedQuoteQuantities.join(" / ")
          : draft?.quantity
            ? String(draft.quantity)
            : summary?.quantity
              ? String(summary.quantity)
              : part?.quantity
                ? String(part.quantity)
                : "—",
    },
    {
      label: "Thread",
      value:
        formatTextValue(draft?.threads) ||
        formatTextValue(extraction?.threads?.join(", ")) ||
        "—",
    },
  ];
}

export function PartProductDataBar({ part, summary, extraction, draft }: PartProductDataBarProps) {
  const fields = buildDataFields({ part, summary, extraction, draft });

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {fields.map((field) => (
        <div key={field.label} className="flex items-baseline gap-1.5">
          <span className="text-[11px] text-white/40">{field.label}</span>
          <span className="text-[12px] font-medium text-white">{field.value}</span>
        </div>
      ))}
    </div>
  );
}
