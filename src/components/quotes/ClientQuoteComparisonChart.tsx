import { useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
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
import {
  epochDayToIsoDate,
  formatCivilDate,
  formatUnknownCostComponents,
  getDeadlineStatus,
  isoDateToEpochDay,
  type DeadlineStatus,
  type DeliveredComparisonRow,
} from "@/features/quotes/delivered-comparison";
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
  readonly diagnosticsEnabled?: boolean;
  readonly colorMode?: "vendor" | "monochrome";
  /** `delivered` (OVD-571) plots projected delivered dates against expected out-the-door cost. */
  readonly axes?: "working_days" | "delivered";
  readonly deliveredRows?: readonly DeliveredComparisonRow[];
  readonly orderLocalDate?: string | null;
  readonly deadline?: string | null;
  readonly onDeadlineChange?: (next: string) => void;
  readonly onSelect: (option: ClientQuoteSelectionOption) => void;
  readonly onHover: (key: string | null) => void;
};

type ChartPoint = {
  x: number;
  y: number;
  key: string;
  vendorKey: VendorName;
  label: string;
  supplier: string;
  tier: string | null;
  sourcing: string | null;
  geographicOrigin: ClientQuoteSelectionOption["geographicOrigin"];
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

const FIXED_POINT_RADIUS = 7;
const FIXED_POINT_AREA = Math.PI * FIXED_POINT_RADIUS * FIXED_POINT_RADIUS;
const NA_ZONE_PADDING = 3;
const NA_ZONE_WIDTH = 8;

function getChartPointFill(point: ChartPoint, colorMode: "vendor" | "monochrome") {
  if (colorMode === "vendor") {
    return getVendorColor(point.vendorKey);
  }
  if (point.selected) {
    return "var(--accent-red)";
  }
  return "var(--muted-ink)";
}

function formatChartGeographicOrigin(origin: ChartPoint["geographicOrigin"]) {
  if (origin === "domestic") return "US";
  if (origin === "foreign") return "International";
  return "Unknown";
}

function decorateChartPointVisuals(
  point: ChartPoint,
  colorMode: "vendor" | "monochrome",
): DecoratedChartPoint {
  const isActive = point.selected || point.hovered;
  const fillOpacity = point.disabled ? 0.35 : isActive ? 1 : 0.8;

  let stroke = "var(--hairline)";
  if (point.selected) {
    stroke = "var(--accent-red)";
  } else if (isActive) {
    stroke = "var(--text)";
  }

  let strokeWidth = 1;
  if (point.selected) {
    strokeWidth = 2.5;
  } else if (isActive) {
    strokeWidth = 1.5;
  }

  return {
    ...point,
    size: FIXED_POINT_AREA,
    fill: getChartPointFill(point, colorMode),
    fillOpacity,
    stroke,
    strokeWidth,
  };
}

function buildChartData(
  options: readonly ClientQuoteSelectionOption[],
  selectedKey: string | null,
  hoveredKey: string | null,
  colorMode: "vendor" | "monochrome",
) {
  const leadTimes = options
    .map((o) => o.leadTimeBusinessDays)
    .filter((v): v is number => v !== null && v >= 0);
  const maxLeadTime = leadTimes.length > 0 ? Math.max(...leadTimes) : 20;
  const naZoneStart = maxLeadTime + NA_ZONE_PADDING;

  let naIndex = 0;
  const points = options
    .map((option): ChartPoint => {
      const leadTimeDays =
        option.leadTimeBusinessDays !== null && option.leadTimeBusinessDays >= 0
          ? option.leadTimeBusinessDays
          : null;
      let xValue: number;
      let isNaZone = false;

      if (leadTimeDays !== null) {
        xValue = leadTimeDays;
      } else {
        isNaZone = true;
        xValue = naZoneStart + 1 + (naIndex % 4) * 1.5 + (naIndex >= 4 ? 0.75 : 0);
        naIndex += 1;
      }

      return {
        x: xValue,
        y: option.totalPriceUsd,
        key: option.key,
        vendorKey: option.vendorKey,
        label: `${option.supplier}${option.tier ? ` · ${option.tier}` : ""}`,
        supplier: option.supplier,
        tier: option.tier,
        sourcing: option.sourcing,
        geographicOrigin: option.geographicOrigin,
        unitPrice: option.unitPriceUsd,
        totalPrice: option.totalPriceUsd,
        leadTimeDays,
        process: option.process,
        material: option.material,
        selected: selectedKey === option.key,
        hovered: hoveredKey === option.key,
        disabled: !option.eligible,
        isNaZone,
        size: FIXED_POINT_AREA,
        fill: "",
        fillOpacity: 0,
        stroke: "",
        strokeWidth: 0,
        option,
      };
    })
    .map((point) => decorateChartPointVisuals(point, colorMode));

  const vendorKeys = [...new Set(options.map((o) => o.vendorKey))];
  const pointsByVendor = new Map<VendorName, ChartPoint[]>();
  for (const point of points) {
    const existing = pointsByVendor.get(point.vendorKey) ?? [];
    existing.push(point);
    pointsByVendor.set(point.vendorKey, existing);
  }

  const hasNaZone = points.some((p) => p.isNaZone);
  const xDomainMax = hasNaZone ? naZoneStart + NA_ZONE_WIDTH : maxLeadTime + 2;

  return { points, pointsByVendor, vendorKeys, naZoneStart, xDomainMax, hasNaZone };
}

function CustomTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload?.[0]) {
    return null;
  }

  const point = payload[0].payload;
  let leadDisplay = "Not quoted";
  if (point.leadTimeDays !== null) {
    const dayLabel = point.leadTimeDays === 1 ? "day" : "days";
    leadDisplay = `${point.leadTimeDays} working ${dayLabel}`;
  }

  return (
    <div className="rounded border border-border bg-ws-raised px-3 py-2.5">
      <p className="text-xs font-semibold text-foreground">
        {point.supplier}
        {point.tier ? ` · ${point.tier}` : ""}
        {point.geographicOrigin !== "unknown" && point.sourcing ? ` · ${point.sourcing}` : ""}
        {` · ${formatChartGeographicOrigin(point.geographicOrigin)}`}
      </p>
      <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
        <p>Quoted total: {formatCurrency(point.totalPrice)}</p>
        <p>Unit: {formatCurrency(point.unitPrice)}/unit</p>
        <p>Ready to ship: {leadDisplay}</p>
        {point.process ? <p>{point.process}</p> : null}
        {point.material ? <p>{point.material}</p> : null}
      </div>
    </div>
  );
}

/**
 * Plot quote options as independent fixed-size points.
 *
 * `working_days` (default) plots ready-to-ship working days against quoted
 * totals. `delivered` (OVD-571) plots projected delivered calendar dates
 * against expected out-the-door cost with an adjustable deadline line. Hover
 * and selection state are surfaced through point styling and routed back to
 * the caller. Callers can opt out of diagnostics or use a neutral monochrome
 * treatment for illustrative data.
 */
export function ClientQuoteComparisonChart(props: ClientQuoteComparisonChartProps) {
  return props.axes === "delivered"
    ? <DeliveredQuoteComparisonChart {...props} />
    : <WorkingDaysQuoteComparisonChart {...props} />;
}

function WorkingDaysQuoteComparisonChart({
  options,
  selectedKey,
  hoveredKey,
  partId = null,
  organizationId = null,
  diagnosticsEnabled = true,
  colorMode = "monochrome",
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
  } = useMemo(
    () => buildChartData(options, selectedKey, hoveredKey, colorMode),
    [colorMode, options, selectedKey, hoveredKey],
  );

  const chartConfig = useMemo(
    () => buildVendorChartConfig(vendorKeys),
    [vendorKeys],
  );

  useEffect(() => {
    if (!diagnosticsEnabled) {
      return;
    }

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
  }, [diagnosticsEnabled, options, organizationId, partId, points]);

  return (
    <ChartContainer
      config={chartConfig}
      className="h-[320px] w-full sm:h-[420px]"
      role="group"
      aria-label="Quote comparison by ready-to-ship working days and quoted total"
    >
      <ScatterChart
        accessibilityLayer
        margin={{ top: 16, right: 20, bottom: 24, left: 6 }}
      >
        <CartesianGrid stroke="var(--hairline)" />
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
            value="Ready-to-ship lead time (working days)"
            position="insideBottom"
            offset={-12}
            style={{ fill: "var(--muted-ink)", fontSize: 10 }}
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
            value="Quoted total"
            angle={-90}
            position="insideLeft"
            offset={4}
            style={{ fill: "var(--muted-ink)", fontSize: 10 }}
          />
        </YAxis>
        <ZAxis
          type="number"
          dataKey="size"
          range={[FIXED_POINT_AREA, FIXED_POINT_AREA]}
        />

        {hasNaZone ? (
          <ReferenceArea
            x1={naZoneStart}
            x2={xDomainMax}
            fill="var(--surface-2)"
            strokeOpacity={0}
          >
            <Label
              value="Lead not quoted"
              position="insideTop"
              offset={8}
              style={{
                fill: "var(--muted-ink)",
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
            fill={colorMode === "monochrome" ? "var(--muted-ink)" : getVendorColor(vendorKey)}
            line={false}
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

// Recharts plot-area insets for the delivered chart: margin + Y-axis width on
// the left, margin on the right, margin + default X-axis height at the bottom.
const DELIVERED_MARGIN = { top: 16, right: 20, bottom: 24, left: 6 } as const;
const DELIVERED_Y_AXIS_WIDTH = 80;
const DELIVERED_X_AXIS_HEIGHT = 30;
const DELIVERED_PLOT_INSET = {
  left: DELIVERED_MARGIN.left + DELIVERED_Y_AXIS_WIDTH,
  right: DELIVERED_MARGIN.right,
  top: DELIVERED_MARGIN.top,
  bottom: DELIVERED_MARGIN.bottom + DELIVERED_X_AXIS_HEIGHT,
};
const DELIVERED_DOMAIN_LEAD_DAYS = 1;
const DELIVERED_DOMAIN_TAIL_DAYS = 14;
const LATE_POINT_OPACITY = 0.35;

type DeliveredChartPoint = {
  key: string;
  x: number;
  y: number;
  size: number;
  fill: string;
  hollow: boolean;
  opacity: number;
  selected: boolean;
  hovered: boolean;
  deadlineStatus: DeadlineStatus;
  label: string;
  row: DeliveredComparisonRow;
};

function describeDeliveredArrival(row: DeliveredComparisonRow): string {
  if (row.arrival.kind === "arrival") {
    const suffix = row.arrival.provenance === "estimated" ? " (estimated)" : "";
    return `Delivered ${formatCivilDate(row.arrival.date)}${suffix}`;
  }
  if (row.arrival.kind === "ships_by") {
    return `Ships ${formatCivilDate(row.arrival.shipDate)}; transit not quoted, arrives later`;
  }
  return "Arrival unknown";
}

function describeDeliveredOtd(row: DeliveredComparisonRow): string {
  if (row.otd.kind === "complete") {
    const suffix = row.otd.provenance === "estimated" ? " (estimated)" : "";
    return `Expected OTD ${formatCurrency(row.otd.amountUsd)}${suffix}`;
  }
  if (row.otd.kind === "partial") {
    return `Expected OTD at least ${formatCurrency(row.otd.knownAmountUsd)}; ${formatUnknownCostComponents(row.otd.unknownComponents)} not quoted`;
  }
  return "Expected OTD unknown";
}

function describeDeadlineStatus(status: DeadlineStatus): string | null {
  if (status === "late") return "Misses deadline";
  if (status === "on_time") return "Meets deadline";
  if (status === "unconfirmed") return "Deadline fit unconfirmed";
  return null;
}

function DeliveredTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: DeliveredChartPoint }> }) {
  if (!active || !payload?.[0]) {
    return null;
  }
  const point = payload[0].payload;
  const status = describeDeadlineStatus(point.deadlineStatus);
  return (
    <div className="rounded border border-border bg-ws-raised px-3 py-2.5">
      <p className="text-xs font-semibold text-foreground">{point.label}</p>
      <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
        <p>{describeDeliveredArrival(point.row)}</p>
        <p>{describeDeliveredOtd(point.row)}</p>
        {status ? <p>{status}</p> : null}
      </div>
    </div>
  );
}

function DeliveredPointShape(props: { cx?: number; cy?: number; payload?: DeliveredChartPoint }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload) {
    return null;
  }
  const isActive = payload.selected || payload.hovered;
  return (
    <g opacity={payload.opacity} data-quote-point={payload.key}>
      <title>{`${payload.label}. ${describeDeliveredArrival(payload.row)}. ${describeDeliveredOtd(payload.row)}.`}</title>
      {payload.selected ? (
        <circle cx={cx} cy={cy} r={FIXED_POINT_RADIUS + 3.5} fill="none" stroke="var(--accent-red)" strokeWidth={2} />
      ) : null}
      <circle
        cx={cx}
        cy={cy}
        r={FIXED_POINT_RADIUS}
        fill={payload.fill}
        fillOpacity={payload.hollow ? 0.18 : 1}
        stroke={payload.hollow ? payload.fill : isActive ? "var(--text)" : "var(--hairline)"}
        strokeWidth={payload.hollow || isActive ? 1.75 : 1}
        strokeDasharray={payload.hollow ? "3 2" : undefined}
      />
    </g>
  );
}

function clampDay(day: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(day)));
}

function DeadlineHandle({
  deadlineDay,
  domainMin,
  domainMax,
  minDay,
  onChange,
}: Readonly<{
  deadlineDay: number;
  domainMin: number;
  domainMax: number;
  minDay: number;
  onChange: (next: string) => void;
}>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const span = Math.max(1, domainMax - domainMin);
  const percent = ((deadlineDay - domainMin) / span) * 100;
  const isoDate = epochDayToIsoDate(deadlineDay);

  const emit = (day: number) => {
    const next = clampDay(day, minDay, domainMax);
    if (next !== deadlineDay) {
      onChange(epochDayToIsoDate(next));
    }
  };

  const dayFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !Number.isFinite(clientX)) {
      return null;
    }
    return domainMin + ((clientX - rect.left) / rect.width) * span;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 7, PageDown: -7 };
    if (event.key in steps) {
      event.preventDefault();
      emit(deadlineDay + steps[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault();
      emit(minDay);
    } else if (event.key === "End") {
      event.preventDefault();
      emit(domainMax);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) {
      return;
    }
    const day = dayFromClientX(event.clientX);
    if (day !== null) {
      emit(day);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) {
      return;
    }
    draggingPointer.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      ref={trackRef}
      data-testid="deadline-track"
      className="pointer-events-none absolute"
      style={{
        left: DELIVERED_PLOT_INSET.left,
        right: DELIVERED_PLOT_INSET.right,
        top: DELIVERED_PLOT_INSET.top,
        bottom: DELIVERED_PLOT_INSET.bottom,
      }}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Deadline"
        aria-orientation="horizontal"
        aria-valuemin={minDay}
        aria-valuemax={domainMax}
        aria-valuenow={deadlineDay}
        aria-valuetext={formatCivilDate(isoDate)}
        data-domain-min={minDay}
        data-domain-max={domainMax}
        className="group pointer-events-auto absolute inset-y-0 flex w-11 -translate-x-1/2 cursor-ew-resize justify-center outline-none"
        style={{ left: `${percent}%`, touchAction: "none" }}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span aria-hidden="true" className="h-full border-l-2 border-dashed border-foreground/70 group-focus-visible:border-foreground" />
        <span className="absolute -top-1 whitespace-nowrap rounded-[2px] border border-border bg-ws-raised px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow-sm group-focus-visible:ring-2 group-focus-visible:ring-foreground">
          Deadline {new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(deadlineDay * 86_400_000))}
        </span>
      </div>
    </div>
  );
}

function DeliveredQuoteComparisonChart({
  options,
  deliveredRows = [],
  orderLocalDate = null,
  deadline = null,
  onDeadlineChange,
  selectedKey,
  hoveredKey,
  partId = null,
  organizationId = null,
  diagnosticsEnabled = true,
  onSelect,
  onHover,
}: ClientQuoteComparisonChartProps) {
  const { points, pointsByVendor, vendorKeys, domainMin, domainMax, minDay } = useMemo(() => {
    const plotted = deliveredRows.flatMap((row): DeliveredChartPoint[] => {
      if (!row.plot) {
        return [];
      }
      const deadlineStatus = getDeadlineStatus(row, deadline);
      return [{
        key: row.key,
        x: row.plot.x,
        y: row.plot.y,
        size: FIXED_POINT_AREA,
        fill: getVendorColor(row.option.vendorKey),
        hollow: !row.plot.exact,
        opacity: deadlineStatus === "late" || !row.option.isSelectable ? LATE_POINT_OPACITY : 1,
        selected: selectedKey === row.key,
        hovered: hoveredKey === row.key,
        deadlineStatus,
        label: `${row.option.vendorLabel}${row.option.laneLabel ?? row.option.tier ? ` · ${row.option.laneLabel ?? row.option.tier}` : ""}`,
        row,
      }];
    });
    const orderDay = orderLocalDate ? isoDateToEpochDay(orderLocalDate) : null;
    const deadlineDay = deadline ? isoDateToEpochDay(deadline) : null;
    const dataDays = [
      ...plotted.map((point) => point.x),
      ...(orderDay === null ? [] : [orderDay]),
    ];
    const days = deadlineDay === null ? dataDays : [...dataDays, deadlineDay];
    const lowest = days.length > 0 ? Math.min(...days) : 0;
    // The tail anchors on data only, so moving the deadline never grows the axis under the pointer.
    const dataTail = (dataDays.length > 0 ? Math.max(...dataDays) : lowest) + DELIVERED_DOMAIN_TAIL_DAYS;
    const byVendor = new Map<VendorName, DeliveredChartPoint[]>();
    for (const point of plotted) {
      byVendor.set(point.row.option.vendorKey, [...(byVendor.get(point.row.option.vendorKey) ?? []), point]);
    }
    return {
      points: plotted,
      pointsByVendor: byVendor,
      vendorKeys: [...byVendor.keys()],
      domainMin: lowest - DELIVERED_DOMAIN_LEAD_DAYS,
      domainMax: Math.max(dataTail, deadlineDay ?? dataTail),
      minDay: orderDay ?? lowest,
    };
  }, [deadline, deliveredRows, hoveredKey, orderLocalDate, selectedKey]);

  const chartConfig = useMemo(() => buildVendorChartConfig(vendorKeys), [vendorKeys]);
  const deadlineDay = deadline ? isoDateToEpochDay(deadline) : null;

  useEffect(() => {
    if (!diagnosticsEnabled) {
      return;
    }
    logQuoteChartPointDiagnostics({
      partId,
      organizationId,
      options,
      points: points.map((point) => ({
        key: point.key,
        vendorKey: point.row.option.vendorKey,
        x: point.x,
        y: point.y,
        exact: !point.hollow,
        deadlineStatus: point.deadlineStatus,
      })),
    });
  }, [diagnosticsEnabled, options, organizationId, partId, points]);

  return (
    <div className="relative">
      <ChartContainer
        config={chartConfig}
        className="h-[320px] w-full sm:h-[420px]"
        role="group"
        aria-label="Quote comparison by delivered date and expected out-the-door cost"
      >
        <ScatterChart accessibilityLayer margin={DELIVERED_MARGIN}>
          <CartesianGrid stroke="var(--hairline)" />
          <XAxis
            type="number"
            dataKey="x"
            domain={[domainMin, domainMax]}
            allowDataOverflow
            height={DELIVERED_X_AXIS_HEIGHT}
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            tickFormatter={(value: number) =>
              new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
                new Date(Math.round(value) * 86_400_000),
              )}
          >
            <Label
              value="Delivered date"
              position="insideBottom"
              offset={-12}
              style={{ fill: "var(--muted-ink)", fontSize: 10 }}
            />
          </XAxis>
          <YAxis
            type="number"
            dataKey="y"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            tickFormatter={(value: number) => formatCurrency(value)}
            width={DELIVERED_Y_AXIS_WIDTH}
          >
            <Label
              value="Expected OTD (out-the-door)"
              angle={-90}
              position="insideLeft"
              offset={4}
              style={{ fill: "var(--muted-ink)", fontSize: 10 }}
            />
          </YAxis>
          <ZAxis type="number" dataKey="size" range={[FIXED_POINT_AREA, FIXED_POINT_AREA]} />
          <ChartTooltip cursor={false} content={<DeliveredTooltipContent />} />
          {vendorKeys.map((vendorKey) => (
            <Scatter
              key={vendorKey}
              name={vendorKey}
              data={pointsByVendor.get(vendorKey) ?? []}
              fill={getVendorColor(vendorKey)}
              line={false}
              isAnimationActive={false}
              shape={(shapeProps: unknown) => <DeliveredPointShape {...(shapeProps as { cx?: number; cy?: number; payload?: DeliveredChartPoint })} />}
              onClick={(point) => {
                const payload = (point as { payload?: DeliveredChartPoint } | undefined)?.payload;
                if (payload?.row.option.isSelectable) {
                  onSelect(payload.row.option);
                }
              }}
              onMouseEnter={(point) => {
                const payload = (point as { payload?: DeliveredChartPoint } | undefined)?.payload;
                if (payload) {
                  onHover(payload.key);
                }
              }}
              onMouseLeave={() => onHover(null)}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
      {deadlineDay !== null && onDeadlineChange ? (
        <DeadlineHandle
          deadlineDay={deadlineDay}
          domainMin={domainMin}
          domainMax={domainMax}
          minDay={minDay}
          onChange={onDeadlineChange}
        />
      ) : null}
    </div>
  );
}
