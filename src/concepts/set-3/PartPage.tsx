import { useMemo, useState } from "react";
import { FileText, FolderOpen, CheckCircle2, SquareStack, AlertTriangle } from "lucide-react";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_VENDOR_QUOTES } from "@/concepts/mock-data";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06] text-white/60">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];
const DEFAULT_SELECTED_QUOTE = MOCK_VENDOR_QUOTES.find((quote) => quote.selected)?.vendor ?? MOCK_VENDOR_QUOTES[0]?.vendor ?? "";

type GeometryFeatureClass = "pocket" | "wall" | "hole" | "contour" | "cosmetic";
type GeometryFeature = {
  id: string;
  label: string;
  kind: GeometryFeatureClass;
  risk?: "low" | "medium" | "high";
};

const MOCK_GEOMETRY_PROJECTION: GeometryFeature[] = [
  { id: "f-pocket-01", label: "Deep pocket (X2)", kind: "pocket", risk: "high" },
  { id: "f-wall-02", label: "Thin wall section", kind: "wall", risk: "high" },
  { id: "f-hole-03", label: "High aspect-ratio holes", kind: "hole", risk: "medium" },
  { id: "f-contour-04", label: "Complex contour edge", kind: "contour", risk: "medium" },
  { id: "f-cosmetic-05", label: "Cosmetic A-surface", kind: "cosmetic", risk: "low" },
];

const QUOTE_DRIVER_MAP: Record<string, string[]> = {
  "Prime Machining": ["f-pocket-01", "f-hole-03"],
  "Titan Precision": ["f-wall-02", "f-contour-04"],
  "Vector Manufacturing": ["f-cosmetic-05", "f-contour-04"],
  "Apex CNC": ["f-wall-02", "f-pocket-01"],
};

function DrawingArea() {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden border-b border-white/[0.08] bg-[#050810]">
      <div className="absolute inset-0 opacity-[0.035]"
        style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(0,200,255,0.5) 23px, rgba(0,200,255,0.5) 24px), repeating-linear-gradient(90deg, transparent, transparent 23px, rgba(0,200,255,0.5) 23px, rgba(0,200,255,0.5) 24px)" }} />
      <div className="z-10 flex flex-col items-center gap-3">
        <FileText className="h-14 w-14 text-sky-400/20" />
        <div className="text-center">
          <p className="font-mono text-base font-semibold text-sky-400/40">{part.partNumber}</p>
          <p className="mt-1 text-[11px] text-white/25">AHA-01093-C_RevC.pdf · 3 pages</p>
        </div>
        <button type="button" className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium text-sky-400 hover:bg-sky-400/15 transition">
          Open Drawing
        </button>
      </div>
    </div>
  );
}

function GeometryView({
  overlayEnabled,
  activeFeatureIds,
  onFeatureSelect,
}: {
  overlayEnabled: boolean;
  activeFeatureIds: Set<string>;
  onFeatureSelect: (featureId: string) => void;
}) {
  const riskToneClass: Record<NonNullable<GeometryFeature["risk"]>, string> = {
    low: "border-emerald-400/35 bg-emerald-500/[0.08] text-emerald-300",
    medium: "border-amber-400/35 bg-amber-500/[0.08] text-amber-300",
    high: "border-rose-400/45 bg-rose-500/[0.14] text-rose-200",
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-sky-300/20 bg-[#060c1a]">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
        <div className="flex items-center gap-2">
          <SquareStack className="h-4 w-4 text-sky-300/80" />
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-200/85">Manufacturing Geometry</p>
        </div>
        <span className="rounded border border-sky-300/25 px-1.5 py-0.5 text-[10px] text-sky-300/85">Heerich Concept</span>
      </div>

      <div className="grid flex-1 grid-cols-2 gap-2 p-3">
        {MOCK_GEOMETRY_PROJECTION.map((feature) => {
          const active = activeFeatureIds.has(feature.id);
          const overlayClass = overlayEnabled && feature.risk ? riskToneClass[feature.risk] : "border-white/[0.1] bg-white/[0.03] text-white/70";
          return (
            <button
              key={feature.id}
              type="button"
              onClick={() => onFeatureSelect(feature.id)}
              className={`rounded-xl border px-3 py-2 text-left transition ${overlayClass} ${active ? "ring-2 ring-sky-300/60 shadow-[0_0_20px_rgba(56,189,248,0.24)]" : "hover:border-sky-300/45"}`}
            >
              <p className="text-xs font-medium">{feature.label}</p>
              <p className="mt-1 font-mono text-[10px] opacity-80">{feature.kind}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpecCard() {
  const fields = [
    ["Part Number", part.partNumber, true],
    ["Revision", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Quantity", String(part.quantity), false],
  ] as const;

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Specifications</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-white/35">{label}</span>
            <span className={`text-[13px] text-white/85 ${mono ? "font-mono" : ""}`}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const chartData = MOCK_VENDOR_QUOTES.map((q) => ({
  x: q.leadTimeDays,
  y: q.price,
  vendor: q.vendor,
  tier: q.tier,
  selected: q.selected,
}));
const avgPrice = Math.round(MOCK_VENDOR_QUOTES.reduce((s, q) => s + q.price, 0) / MOCK_VENDOR_QUOTES.length);

type AtlasTooltipPayload = { payload?: { vendor: string; y: number; x: number; tier: string } };

function AtlasTooltip({ active, payload }: { active?: boolean; payload?: AtlasTooltipPayload[] }) {
  if (!active || !payload?.[0]?.payload) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-xl border border-sky-400/20 bg-[#060c1a] px-3 py-2 text-xs shadow-xl">
      <p className="font-semibold text-sky-300">{d.vendor}</p>
      <p className="text-white/40">{d.tier}</p>
      <p className="mt-1 font-mono text-white/70">${d.y} · {d.x}d lead</p>
    </div>
  );
}

function QuoteScatterChart() {
  return (
    <div className="rounded-2xl border border-sky-400/15 bg-[#060c1a] p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-400/60">Price vs Lead Time</p>
      <ResponsiveContainer width="100%" height={160}>
        <ScatterChart margin={{ top: 8, right: 20, bottom: 12, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(56,189,248,0.07)" />
          <XAxis dataKey="x" type="number" name="lead" unit="d"
            tick={{ fill: "rgba(56,189,248,0.4)", fontSize: 10 }} tickLine={false} axisLine={false} domain={[4, 20]} />
          <YAxis dataKey="y" type="number" name="price"
            tick={{ fill: "rgba(56,189,248,0.4)", fontSize: 10 }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => `$${v}`} width={42} />
          <ReferenceLine y={avgPrice} stroke="rgba(56,189,248,0.2)" strokeDasharray="4 4"
            label={{ value: `avg $${avgPrice}`, position: "right", fill: "rgba(56,189,248,0.35)", fontSize: 9 }} />
          <Tooltip content={<AtlasTooltip />} />
          <Scatter data={chartData} shape={(props: { cx?: number; cy?: number; payload?: typeof chartData[0] }) => {
            const { cx = 0, cy = 0, payload } = props;
            const isSelected = payload?.selected;
            return (
              <g>
                {isSelected && <circle cx={cx} cy={cy} r={10} fill="rgba(56,189,248,0.12)" stroke="rgba(56,189,248,0.5)" strokeWidth={1} />}
                <circle cx={cx} cy={cy} r={isSelected ? 6 : 4.5} fill={isSelected ? "#38bdf8" : "rgba(56,189,248,0.45)"} />
              </g>
            );
          }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function VendorCards({
  selectedVendor,
  hoveredVendor,
  onSelectVendor,
  onHoverVendor,
}: {
  selectedVendor: string;
  hoveredVendor: string | null;
  onSelectVendor: (vendor: string) => void;
  onHoverVendor: (vendor: string | null) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Quotes — {MOCK_VENDOR_QUOTES.length} received</p>
      <div className="space-y-2">
        {MOCK_VENDOR_QUOTES.map((q, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSelectVendor(q.vendor)}
            onMouseEnter={() => onHoverVendor(q.vendor)}
            onMouseLeave={() => onHoverVendor(null)}
            className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${selectedVendor === q.vendor ? "border-sky-400/25 bg-sky-500/[0.07] ring-1 ring-sky-400/15" : "border-white/[0.06] bg-white/[0.02] hover:border-sky-300/35"} ${hoveredVendor === q.vendor ? "shadow-[0_0_18px_rgba(56,189,248,0.22)]" : ""}`}
          >
            <div>
              <div className="flex items-center gap-1.5">
                {selectedVendor === q.vendor && <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />}
                <span className="text-sm font-medium text-white/90">{q.vendor}</span>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-white/40">{q.tier} · {q.leadTimeDays}d</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-lg font-semibold text-white">${q.price}</p>
              {q.cert && <span className="text-[10px] text-sky-400/70">{q.cert}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Set3PartPage() {
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [selectedVendor, setSelectedVendor] = useState(DEFAULT_SELECTED_QUOTE);
  const [hoveredVendor, setHoveredVendor] = useState<string | null>(null);
  const [manuallyFocusedFeature, setManuallyFocusedFeature] = useState<string | null>(null);

  const activeDriverFeatureIds = useMemo(() => {
    const hoveredIds = hoveredVendor ? QUOTE_DRIVER_MAP[hoveredVendor] ?? [] : [];
    if (hoveredIds.length) return new Set(hoveredIds);

    const selectedIds = selectedVendor ? QUOTE_DRIVER_MAP[selectedVendor] ?? [] : [];
    if (selectedIds.length) return new Set(selectedIds);

    return new Set<string>();
  }, [hoveredVendor, selectedVendor]);

  const activeFeatureIds = useMemo(() => {
    if (manuallyFocusedFeature) {
      return new Set([...activeDriverFeatureIds, manuallyFocusedFeature]);
    }
    return activeDriverFeatureIds;
  }, [activeDriverFeatureIds, manuallyFocusedFeature]);

  const activeVendor = hoveredVendor ?? selectedVendor;
  const activeDriverLabels = (QUOTE_DRIVER_MAP[activeVendor] ?? [])
    .map((featureId) => MOCK_GEOMETRY_PROJECTION.find((feature) => feature.id === featureId)?.label)
    .filter((label): label is string => Boolean(label));

  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly">
      <div className="flex h-full flex-col">
        <div className="grid h-80 shrink-0 grid-cols-2 gap-3 border-b border-white/[0.08] p-3">
          <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
            <DrawingArea />
          </div>
          <GeometryView overlayEnabled={overlayEnabled} activeFeatureIds={activeFeatureIds} onFeatureSelect={setManuallyFocusedFeature} />
        </div>
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-3 gap-4 p-4">
            <div className="space-y-4">
              <SpecCard />
              <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Geometry Overlay</p>
                  <button
                    type="button"
                    onClick={() => setOverlayEnabled((enabled) => !enabled)}
                    className={`rounded-md border px-2 py-1 text-[10px] font-medium transition ${overlayEnabled ? "border-sky-300/45 bg-sky-400/15 text-sky-200" : "border-white/[0.16] text-white/60 hover:border-sky-300/35"}`}
                  >
                    {overlayEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg border border-rose-300/30 bg-rose-500/[0.08] p-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-rose-300" />
                    <p className="text-[11px] text-rose-100/90">Thin wall + deep pocket risk found in current model.</p>
                  </div>
                  <p className="text-[11px] leading-relaxed text-white/60">
                    Quote sync driver{activeDriverLabels.length === 1 ? "" : "s"}: <span className="text-sky-300/90">{activeDriverLabels.join(", ") || "None mapped"}</span>
                  </p>
                  <p className="text-[10px] text-white/35">Experimental concept only. Keep drawing as source of truth. Heerich rendering concept with mock geometry_projection JSON.</p>
                </div>
              </div>
            </div>
            <div className="col-span-2 space-y-4">
              <QuoteScatterChart />
              <VendorCards selectedVendor={selectedVendor} hoveredVendor={hoveredVendor} onSelectVendor={setSelectedVendor} onHoverVendor={setHoveredVendor} />
            </div>
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
