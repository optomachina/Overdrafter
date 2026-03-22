import { useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, SVGProps } from "react";
import {
  CartesianGrid,
  Label,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { getVendorColor } from "@/features/quotes/vendor-colors";
import { formatCurrency } from "@/features/quotes/utils";

type QuoteChartProps = {
  quotes: ClientQuoteSelectionOption[];
  selectedOfferId: string | null;
  onSelect: (offerId: string | null) => void;
};

type ChartPoint = {
  offerId: string;
  vendorKey: ClientQuoteSelectionOption["vendorKey"];
  vendorLabel: string;
  tier: string | null;
  sourcing: string | null;
  leadTimeBusinessDays: number;
  unitPriceUsd: number;
};

type ChartSeries = {
  vendorKey: ClientQuoteSelectionOption["vendorKey"];
  vendorLabel: string;
  color: string;
  points: ChartPoint[];
};

type ShapeProps = SVGProps<SVGCircleElement> & {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
};

function buildSeries(quotes: ClientQuoteSelectionOption[]): ChartSeries[] {
  const byVendor = new Map<ClientQuoteSelectionOption["vendorKey"], ChartSeries>();

  for (const quote of quotes) {
    if (
      quote.leadTimeBusinessDays === null ||
      !Number.isFinite(quote.leadTimeBusinessDays) ||
      !Number.isFinite(quote.unitPriceUsd)
    ) {
      continue;
    }

    const existing = byVendor.get(quote.vendorKey);
    const point: ChartPoint = {
      offerId: quote.offerId,
      vendorKey: quote.vendorKey,
      vendorLabel: quote.vendorLabel,
      tier: quote.tier,
      sourcing: quote.sourcing,
      leadTimeBusinessDays: quote.leadTimeBusinessDays,
      unitPriceUsd: quote.unitPriceUsd,
    };

    if (existing) {
      existing.points.push(point);
      continue;
    }

    byVendor.set(quote.vendorKey, {
      vendorKey: quote.vendorKey,
      vendorLabel: quote.vendorLabel,
      color: getVendorColor(quote.vendorKey),
      points: [point],
    });
  }

  return [...byVendor.values()];
}

function QuoteChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
}) {
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-xs text-white/80 shadow-xl">
      <p className="font-semibold text-white">{point.vendorLabel}</p>
      {point.tier || point.sourcing ? (
        <p className="text-white/55">{[point.tier, point.sourcing].filter(Boolean).join(" · ")}</p>
      ) : null}
      <p className="mt-1">{formatCurrency(point.unitPriceUsd)} / ea</p>
      <p>{point.leadTimeBusinessDays} bd lead time</p>
    </div>
  );
}

export function QuoteChart({ quotes, selectedOfferId, onSelect }: QuoteChartProps) {
  const [hoveredOfferId, setHoveredOfferId] = useState<string | null>(null);
  const series = useMemo(() => buildSeries(quotes), [quotes]);
  const hasSelected = selectedOfferId !== null;

  const allPoints = series.flatMap((entry) => entry.points);
  const xValues = allPoints.map((point) => point.leadTimeBusinessDays);
  const yValues = allPoints.map((point) => point.unitPriceUsd);
  const xMax = xValues.length > 0 ? Math.max(...xValues) + 1 : 1;
  const yMax = yValues.length > 0 ? Math.max(...yValues) * 1.1 : 1;

  const renderShape = (props: ShapeProps) => {
    const point = props.payload;

    if (!point || props.cx === undefined || props.cy === undefined) {
      return null;
    }

    const isSelected = selectedOfferId === point.offerId;
    const isHovered = hoveredOfferId === point.offerId;
    const radius = isSelected ? 10 : isHovered ? 9 : 8;
    const opacity = isSelected ? 1 : hasSelected ? 0.35 : isHovered ? 1 : 0.7;
    const fill = getVendorColor(point.vendorKey);

    const handleClick = (event: ReactMouseEvent<SVGCircleElement>) => {
      event.stopPropagation();
      onSelect(isSelected ? null : point.offerId);
    };

    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        r={radius}
        fill={fill}
        opacity={opacity}
        stroke={isSelected ? "#ffffff" : "transparent"}
        strokeWidth={isSelected ? 2 : 0}
        data-testid={`quote-point-${point.offerId}`}
        aria-label={`${point.vendorLabel} ${point.offerId}`}
        className="cursor-pointer transition-all duration-150"
        onClick={handleClick}
        onMouseEnter={() => setHoveredOfferId(point.offerId)}
        onMouseLeave={() => setHoveredOfferId((current) => (current === point.offerId ? null : current))}
      />
    );
  };

  return (
    <div className="rounded-[14px] border border-ws-border-subtle bg-ws-card p-4">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((entry) => (
          <span key={entry.vendorKey} className="flex items-center gap-1.5 text-xs text-white/55">
            <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
            {entry.vendorLabel}
          </span>
        ))}
      </div>

      <div className="h-[230px] w-full" data-testid="quote-chart-shell">
        <ResponsiveContainer width="100%" height={230}>
          <ScatterChart
            margin={{ top: 8, right: 12, bottom: 20, left: 8 }}
            onClick={(state) => {
              if (!state || !("activePayload" in state) || !state.activePayload?.length) {
                onSelect(null);
              }
            }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
            <XAxis
              type="number"
              dataKey="leadTimeBusinessDays"
              domain={[0, xMax]}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tick={{ fill: "rgba(255,255,255,0.35)" }}
            >
              <Label
                value="Lead time (bd)"
                position="insideBottom"
                offset={-10}
                style={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
              />
            </XAxis>
            <YAxis
              type="number"
              dataKey="unitPriceUsd"
              domain={[0, yMax]}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tick={{ fill: "rgba(255,255,255,0.35)" }}
              tickFormatter={(value: number) => formatCurrency(value)}
              width={84}
            >
              <Label
                value="Price / ea"
                angle={-90}
                position="insideLeft"
                style={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
              />
            </YAxis>
            <Tooltip cursor={false} content={<QuoteChartTooltip />} />
            {series.map((entry) => (
              <Scatter
                key={entry.vendorKey}
                name={entry.vendorLabel}
                data={entry.points}
                fill={entry.color}
                shape={renderShape}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type { QuoteChartProps };
