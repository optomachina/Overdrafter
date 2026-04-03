import { useEffect, useMemo } from "react";
import {
  CartesianGrid,
  Label,
  ReferenceArea,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { VendorName } from "@/integrations/supabase/types";
import { logQuoteChartPointDiagnostics } from "@/features/quotes/quote-chart-diagnostics";
import { formatCurrency } from "@/features/quotes/utils";
import { getVendorColor, buildVendorChartConfig } from "@/features/quotes/vendor-colors";

type ClientQuoteComparisonChartProps = {
  readonly options: readonly ClientQuoteSelectionOption[];
  readonly selectedKey: string | null;
  readonly hoveredKey: string | null;
  readonly partId?: string | null;
  readonly organizationId?: string | null;
  readonly onSelect: (option: ClientQuoteSelectionOption) => void;
  readonly onHover: (key: string | null) => void;
};

type ChartPoint = {
  x: number;
  y: number;
  r: number;
  key: string;
  vendorKey: VendorName;
  label: string;
  supplier: string;
  tier: string | null;
  sourcing: string | null;
  unitPrice: number;
  totalPrice: number;
  leadTimeDays: number | null;
  process: string | null;
  material: string | null;
  selected: boolean;
  hovered: boolean;
  disabled: boolean;
  isNaZone: boolean;
  size: number;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  option: ClientQuoteSelectionOption;
};

type DecoratedChartPoint = ChartPoint;

const MIN_RADIUS = 6;
const MAX_RADIUS = 22;
const NA_ZONE_PADDING = 3;
const NA_ZONE_WIDTH = 8;

function computeBubbleRadius(
  totalPrice: number,
  minPrice: number,
  maxPrice: number,
): number {
  if (maxPrice === minPrice) {
    return (MIN_RADIUS + MAX_RADIUS) / 2;
  }
  const ratio = (totalPrice - minPrice) / (maxPrice - minPrice);
  return MIN_RADIUS + Math.sqrt(ratio) * (MAX_RADIUS - MIN_RADIUS);
}

function decorateChartPointVisuals(point: ChartPoint): DecoratedChartPoint {
  const isActive = point.selected || point.hovered;
  const radius = isActive ? point.r + 2 : point.r;
  const fillOpacity = point.disabled ? 0.25 : isActive ? 1 : 0.8;

  let stroke = "rgba(255,255,255,0.18)";
  if (point.selected) {
    stroke = "#ffffff";
  } else if (isActive) {
    stroke = "rgba(255,255,255,0.5)";
  }

  let strokeWidth = 1;
  if (point.selected) {
    strokeWidth = 2.5;
  } else if (isActive) {
    strokeWidth = 1.5;
  }

  return {
    ...point,
    size: Math.PI * radius * radius,
    fill: getVendorColor(point.vendorKey),
    fillOpacity,
    stroke,
    strokeWidth,
  };
}

function buildChartData(
  options: readonly ClientQuoteSelectionOption[],
  selectedKey: string | null,
  hoveredKey: string | null,
) {
  const totalPrices = options.map((o) => o.totalPriceUsd).filter(Number.isFinite);
  const minTotal = totalPrices.length > 0 ? Math.min(...totalPrices) : 0;
  const maxTotal = totalPrices.length > 0 ? Math.max(...totalPrices) : 1;

  const leadTimes = options
    .map((o) => o.leadTimeBusinessDays)
    .filter((v): v is number => v !== null && v > 0);
  const maxLeadTime = leadTimes.length > 0 ? Math.max(...leadTimes) : 20;
  const naZoneStart = maxLeadTime + NA_ZONE_PADDING;

  let naIndex = 0;
  const points = options
    .map((option): ChartPoint => {
      const hasLeadTime = option.leadTimeBusinessDays !== null && option.leadTimeBusinessDays > 0;
      let xValue: number;
      let isNaZone = false;

      if (hasLeadTime) {
        xValue = option.leadTimeBusinessDays!;
      } else {
        isNaZone = true;
        xValue = naZoneStart + 1 + (naIndex % 4) * 1.5 + (naIndex >= 4 ? 0.75 : 0);
        naIndex += 1;
      }

      return {
        x: xValue,
        y: option.unitPriceUsd,
        r: computeBubbleRadius(option.totalPriceUsd, minTotal, maxTotal),
        key: option.key,
        vendorKey: option.vendorKey,
        label: `${option.supplier}${option.tier ? ` · ${option.tier}` : ""}`,
        supplier: option.supplier,
        tier: option.tier,
        sourcing: option.sourcing,
        unitPrice: option.unitPriceUsd,
        totalPrice: option.totalPriceUsd,
        leadTimeDays: option.leadTimeBusinessDays,
        process: option.process,
        material: option.material,
        selected: selectedKey === option.key,
        hovered: hoveredKey === option.key,
        disabled: !option.eligible,
        isNaZone,
        size: 0,
        fill: "",
        fillOpacity: 0,
        stroke: "",
        strokeWidth: 0,
        option,
      };
    })
    .map(decorateChartPointVisuals);

  const vendorKeys = [...new Set(options.map((o) => o.vendorKey))];
  const pointsByVendor = new Map<VendorName, ChartPoint[]>();
  for (const point of points) {
    const existing = pointsByVendor.get(point.vendorKey) ?? [];
    existing.push(point);
    pointsByVendor.set(point.vendorKey, existing);
  }

  const hasNaZone = points.some((p) => p.isNaZone);
  const xDomainMax = hasNaZone ? naZoneStart + NA_ZONE_WIDTH : maxLeadTime + 2;
  const maxBubbleSize = points.reduce((max, point) => Math.max(max, point.size), 0);

  return { points, pointsByVendor, vendorKeys, naZoneStart, xDomainMax, hasNaZone, maxBubbleSize };
}

function CustomTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload?.[0]) {
    return null;
  }

  const point = payload[0].payload;
  const leadDisplay = point.leadTimeDays !== null ? `${point.leadTimeDays} business days` : "Not quoted";

  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1d2e] px-3 py-2.5 shadow-xl">
      <p className="text-xs font-semibold text-white">
        {point.supplier}
        {point.tier ? ` · ${point.tier}` : ""}
        {point.sourcing ? ` · ${point.sourcing}` : ""}
      </p>
      <div className="mt-1.5 space-y-0.5 text-[11px] text-white/55">
        <p>{formatCurrency(point.unitPrice)}/unit</p>
        <p>Total: {formatCurrency(point.totalPrice)}</p>
        <p>Lead: {leadDisplay}</p>
        {point.process ? <p>{point.process}</p> : null}
        {point.material ? <p>{point.material}</p> : null}
      </div>
    </div>
  );
}

export function ClientQuoteComparisonChart({
  options,
  selectedKey,
  hoveredKey,
  partId = null,
  organizationId = null,
  onSelect,
  onHover,
}: ClientQuoteComparisonChartProps) {
  const {
    points,
    pointsByVendor,
    vendorKeys,
    naZoneStart,
    xDomainMax,
    hasNaZone,
    maxBubbleSize,
  } = useMemo(
    () => buildChartData(options, selectedKey, hoveredKey),
    [options, selectedKey, hoveredKey],
  );

  const chartConfig = useMemo(
    () => buildVendorChartConfig(vendorKeys),
    [vendorKeys],
  );

  useEffect(() => {
    logQuoteChartPointDiagnostics({
      partId,
      organizationId,
      options,
      points: points.map((point) => ({
        key: point.key,
        vendorKey: point.vendorKey,
        x: point.x,
        y: point.y,
        leadTimeDays: point.leadTimeDays,
        totalPrice: point.totalPrice,
        disabled: point.disabled,
        isNaZone: point.isNaZone,
      })),
    });
  }, [options, organizationId, partId, points]);

  return (
    <ChartContainer config={chartConfig} className="h-[420px] w-full">
      <ScatterChart margin={{ top: 16, right: 20, bottom: 24, left: 6 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.06)" />
        <XAxis
          type="number"
          dataKey="x"
          domain={[0, xDomainMax]}
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          tickFormatter={(value: number) => {
            if (value >= naZoneStart) {
              return "";
            }
            return `${value}d`;
          }}
        >
          <Label
            value="Lead Time (business days)"
            position="insideBottom"
            offset={-12}
            style={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
          />
        </XAxis>
        <YAxis
          type="number"
          dataKey="y"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          tickFormatter={(value: number) => formatCurrency(value)}
          width={80}
        >
          <Label
            value="Unit Price"
            angle={-90}
            position="insideLeft"
            offset={4}
            style={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
          />
        </YAxis>
        <ZAxis
          type="number"
          dataKey="size"
          range={[0, maxBubbleSize]}
          domain={[0, maxBubbleSize]}
        />

        {hasNaZone ? (
          <ReferenceArea
            x1={naZoneStart}
            x2={xDomainMax}
            fill="rgba(255,255,255,0.03)"
            strokeOpacity={0}
          >
            <Label
              value="Lead not quoted"
              position="insideTop"
              offset={8}
              style={{
                fill: "rgba(255,255,255,0.25)",
                fontSize: 10,
                fontWeight: 500,
              }}
            />
          </ReferenceArea>
        ) : null}

        <ChartTooltip
          cursor={false}
          content={<CustomTooltipContent />}
        />

        {vendorKeys.map((vendorKey) => (
          <Scatter
            key={vendorKey}
            name={vendorKey}
            data={pointsByVendor.get(vendorKey) ?? []}
            onClick={(point) => {
              const payload = (point as { payload?: ChartPoint } | undefined)?.payload;
              if (payload?.option.isSelectable && !payload.disabled) {
                onSelect(payload.option);
              }
            }}
            onMouseEnter={(point) => {
              const payload = (point as { payload?: ChartPoint } | undefined)?.payload;
              if (payload) {
                onHover(payload.key);
              }
            }}
            onMouseLeave={() => onHover(null)}
          />
        ))}
      </ScatterChart>
    </ChartContainer>
  );
}
