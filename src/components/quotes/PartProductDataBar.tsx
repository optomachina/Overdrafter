import {
  formatTolerance,
  formatTextValue,
} from "@/features/quotes/format-part-fields";
import { requestedServicesSupportQuoteFields } from "@/features/quotes/service-intent";
import type {
  ClientPartRequestUpdateInput,
  DrawingExtractionData,
  JobPartSummary,
  PartAggregate,
} from "@/features/quotes/types";

type PartProductDataBarProps = {
  readonly part: PartAggregate | null | undefined;
  readonly summary: JobPartSummary | null | undefined;
  readonly extraction: DrawingExtractionData | null | undefined;
  readonly draft: ClientPartRequestUpdateInput | null;
};

type DataField = {
  label: string;
  value: string;
  title?: string;
};

function readApprovedQuoteFinish(
  part: PartAggregate | null | undefined,
): string | null {
  const snapshot = part?.approvedRequirement?.spec_snapshot;

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>).quoteFinish;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatCoatingName(specification: string): string {
  if (!/anodiz/i.test(specification)) {
    return specification;
  }

  const color = specification.match(
    /\b(black|clear|natural|red|blue|green|gold|gray|grey)\b/i,
  )?.[1];
  if (!color) {
    return "Anodize";
  }

  const normalizedColor =
    color.toLowerCase() === "grey"
      ? "Gray"
      : `${color[0]!.toUpperCase()}${color.slice(1).toLowerCase()}`;
  return `${normalizedColor} Anodize`;
}

function resolveFinishField(input: PartProductDataBarProps): DataField {
  const { part, extraction, draft } = input;
  const customerOrDrawingValue =
    part?.clientRequirement?.finish?.trim() ||
    extraction?.rawFields?.finish?.raw?.trim() ||
    extraction?.finish.raw?.trim() ||
    part?.approvedRequirement?.finish?.trim() ||
    null;
  const specification =
    draft?.finish?.trim() ||
    part?.clientRequirement?.quoteFinish?.trim() ||
    readApprovedQuoteFinish(part) ||
    extraction?.quoteFinish?.trim() ||
    extraction?.finish.normalized?.trim() ||
    customerOrDrawingValue ||
    "—";
  const titleParts = [`Specification: ${specification}`];

  if (customerOrDrawingValue) {
    titleParts.push(`Customer / drawing: ${customerOrDrawingValue}`);
  }

  return {
    label: "Finish",
    value:
      specification === "—" ? specification : formatCoatingName(specification),
    title: titleParts.join("\n"),
  };
}

function resolveQuantityValue(input: PartProductDataBarProps): string {
  const { part, summary, draft } = input;
  const showQuoteFields = requestedServicesSupportQuoteFields(
    draft?.requestedServiceKinds ?? summary?.requestedServiceKinds,
  );

  if (showQuoteFields && draft?.requestedQuoteQuantities.length) {
    return draft.requestedQuoteQuantities.join(" / ");
  }

  if (draft?.quantity) {
    return String(draft.quantity);
  }

  if (summary?.quantity) {
    return String(summary.quantity);
  }

  if (part?.quantity) {
    return String(part.quantity);
  }

  return "—";
}

function buildDataFields(input: PartProductDataBarProps): DataField[] {
  const { part, extraction, draft } = input;
  const threadValue =
    formatTextValue(draft?.threads) ||
    formatTextValue(extraction?.threads?.join(", "));

  const fields: DataField[] = [
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
    resolveFinishField(input),
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
      value: resolveQuantityValue(input),
    },
  ];

  if (threadValue) {
    fields.push({ label: "Thread", value: threadValue });
  }

  return fields;
}

export function PartProductDataBar({
  part,
  summary,
  extraction,
  draft,
}: PartProductDataBarProps) {
  const fields = buildDataFields({ part, summary, extraction, draft });

  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => (
        <div key={field.label} className="flex items-baseline gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {field.label}
          </span>
          <span
            className="text-[12px] font-medium text-foreground"
            title={field.title}
          >
            {field.value}
          </span>
        </div>
      ))}
    </div>
  );
}
