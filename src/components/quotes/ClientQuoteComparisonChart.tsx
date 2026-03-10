import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";

type ClientQuoteComparisonChartProps = {
  options: readonly ClientQuoteSelectionOption[];
  selectedKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
};

type ChartPoint = {
  x: number;
  y: number;
  z: number;
  key: string;
  label: string;
  delivery: string;
  priceLabel: string;
  selected: boolean;
  disabled: boolean;
  option: ClientQuoteSelectionOption;
};

const chartConfig = {
  eligible: {
    label: "Eligible quotes",
    color: "rgba(255,255,255,0.82)",
  },
} as const;

function buildPoint(option: ClientQuoteSelectionOption, selectedKey: string | null): ChartPoint {
  return {
    x: option.leadTimeBusinessDays ?? 0,
    y: option.totalPriceUsd,
    z: selectedKey === option.key ? 1.2 : 1,
    key: option.key,
    label: `${option.vendorLabel}${option.expedite ? " • Expedite" : ""}`,
    delivery: option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays),
    priceLabel: formatCurrency(option.totalPriceUsd),
    selected: selectedKey === option.key,
    disabled: !option.eligible,
    option,
  };
}

export function ClientQuoteComparisonChart({
  options,
  selectedKey,
  onSelect,
}: ClientQuoteComparisonChartProps) {
  const points = options.map((option) => buildPoint(option, selectedKey));

  return (
    <ChartContainer config={chartConfig} className="h-[320px] w-full">
      <ScatterChart margin={{ top: 16, right: 20, bottom: 8, left: 6 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.08)" />
        <XAxis
          type="number"
          dataKey="x"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          tickFormatter={(value) => `${value}d`}
          label={{ value: "Lead time", position: "insideBottom", offset: -4 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          tickFormatter={(value) => formatCurrency(Number(value))}
          width={92}
          label={{ value: "Total price", angle: -90, position: "insideLeft" }}
        />
        <ChartTooltip
          cursor={{ stroke: "rgba(255,255,255,0.14)" }}
          content={
            <ChartTooltipContent
              formatter={(_, __, item) => {
                const point = item.payload as ChartPoint;

                return (
                  <div className="space-y-1">
                    <div className="font-medium text-foreground">{point.label}</div>
                    <div className="text-muted-foreground">{point.priceLabel}</div>
                    <div className="text-muted-foreground">{point.delivery}</div>
                  </div>
                );
              }}
            />
          }
        />
        <Scatter
          data={points}
          dataKey="y"
          fill="var(--color-eligible)"
          shape={(props: unknown) => {
            const point = props as {
              cx?: number;
              cy?: number;
              payload?: ChartPoint;
            };

            if (!point.payload || point.cx === undefined || point.cy === undefined) {
              return null;
            }

            const radius = point.payload.selected ? 10 : 7;
            const fill = point.payload.selected
              ? "#f5f5f5"
              : point.payload.disabled
                ? "rgba(255,255,255,0.2)"
                : "rgba(255,255,255,0.7)";
            const stroke = point.payload.selected ? "#101010" : "rgba(16,16,16,0.3)";

            return (
              <circle
                cx={point.cx}
                cy={point.cy}
                r={radius}
                fill={fill}
                stroke={stroke}
                strokeWidth={2}
                className="cursor-pointer"
                onClick={() => onSelect(point.payload!.option)}
              />
            );
          }}
        />
      </ScatterChart>
    </ChartContainer>
  );
}
