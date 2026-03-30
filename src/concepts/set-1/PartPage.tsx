import { FileText, CheckCircle2, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_VENDOR_QUOTES, MOCK_ACTIVITY, formatRelativeTime } from "@/concepts/mock-data";
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

const ACTIVITY_ICONS: Record<string, string> = {
  quote_received: "💰",
  spec_updated: "✏️",
  file_uploaded: "📄",
  selection_made: "✅",
};

const VENDOR_COLORS: Record<string, string> = {
  Xometry: "#34d399",
  Protolabs: "#60a5fa",
  eMachineShop: "#a78bfa",
  Fictiv: "#fb923c",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate text-white/70">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];
const chartData = MOCK_VENDOR_QUOTES.map((q) => ({
  x: q.leadTimeDays,
  y: q.price,
  vendor: q.vendor,
  tier: q.tier,
  selected: q.selected,
  fill: q.selected ? "#34d399" : (VENDOR_COLORS[q.vendor] ?? "#94a3b8"),
}));
const avgPrice = Math.round(MOCK_VENDOR_QUOTES.reduce((s, q) => s + q.price, 0) / MOCK_VENDOR_QUOTES.length);

type TooltipPayload = { payload?: { vendor: string; y: number; x: number; tier: string } };

function QuoteTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.[0]?.payload) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/[0.12] bg-[#0d1117] px-3 py-2 text-xs shadow-xl">
      <p className="font-semibold text-white">{d.vendor}</p>
      <p className="text-white/50">{d.tier}</p>
      <p className="mt-1 font-mono text-emerald-400">${d.y} · {d.x}d</p>
    </div>
  );
}

function QuoteScatterChart() {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-ws-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Price vs Lead Time</p>
        <div className="flex gap-3">
          {Object.entries(VENDOR_COLORS).map(([v, c]) => (
            <span key={v} className="flex items-center gap-1 text-[10px] text-white/50">
              <span className="h-2 w-2 rounded-full" style={{ background: c }} />
              {v}
            </span>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="x"
            type="number"
            name="Lead Time"
            unit="d"
            tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            domain={[4, 20]}
            label={{ value: "Lead time (days)", position: "insideBottom", offset: -4, fill: "rgba(255,255,255,0.25)", fontSize: 10 }}
          />
          <YAxis
            dataKey="y"
            type="number"
            name="Price"
            unit="$"
            tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${v}`}
            width={40}
          />
          <ReferenceLine y={avgPrice} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4"
            label={{ value: `avg $${avgPrice}`, position: "right", fill: "rgba(255,255,255,0.3)", fontSize: 9 }} />
          <Tooltip content={<QuoteTooltip />} />
          <Scatter data={chartData} shape={(props: { cx?: number; cy?: number; payload?: typeof chartData[0] }) => {
            const { cx = 0, cy = 0, payload } = props;
            const isSelected = payload?.selected;
            return (
              <g>
                {isSelected && <circle cx={cx} cy={cy} r={10} fill="rgba(52,211,153,0.15)" stroke="rgba(52,211,153,0.4)" strokeWidth={1} />}
                <circle cx={cx} cy={cy} r={isSelected ? 6 : 5} fill={payload?.fill ?? "#94a3b8"} opacity={0.9} />
              </g>
            );
          }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function SpecGrid() {
  const fields: Array<[string, string, boolean]> = [
    ["Part Number", part.partNumber, true],
    ["Revision", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Quantity", String(part.quantity), false],
  ];

  return (
    <div className="rounded-xl border border-white/[0.08] bg-ws-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <FileText className="h-4 w-4 text-white/40" />
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Spec</p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-white/40">{label}</span>
            <span className={`text-sm text-white/85 ${mono ? "font-mono" : ""}`}>{value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <div className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-mono text-white/60">
          AHA-01093-C_RevC.pdf
        </div>
      </div>
    </div>
  );
}

function QuoteTable() {
  return (
    <div className="rounded-xl border border-white/[0.08] overflow-hidden">
      <p className="border-b border-white/[0.06] bg-ws-inset px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Quote Comparison</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] bg-white/[0.02]">
            {["Vendor", "Process", "Price", "Lead", "Tier", "Cert"].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.12em] text-white/35">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MOCK_VENDOR_QUOTES.map((q, i) => (
            <tr key={i} className={`border-b border-white/[0.04] ${q.selected ? "bg-emerald-400/[0.06] ring-1 ring-inset ring-emerald-400/20" : "hover:bg-white/[0.03]"}`}>
              <td className="px-3 py-2.5 font-medium text-white/90">
                <div className="flex items-center gap-1.5">
                  {q.selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                  <span className="h-2 w-2 rounded-full" style={{ background: VENDOR_COLORS[q.vendor] ?? "#94a3b8" }} />
                  {q.vendor}
                </div>
              </td>
              <td className="px-3 py-2.5 text-white/55 text-[12px]">{q.process}</td>
              <td className="px-3 py-2.5 font-mono font-semibold text-white">${q.price}</td>
              <td className="px-3 py-2.5 tabular-nums text-white/70">{q.leadTimeDays}d</td>
              <td className="px-3 py-2.5">
                <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] text-white/60">{q.tier}</span>
              </td>
              <td className="px-3 py-2.5">
                {q.cert ? <span className="rounded-md border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-400">{q.cert}</span> : <span className="text-white/25">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityLog() {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Activity</p>
      <div className="space-y-3">
        {MOCK_ACTIVITY.map((e) => (
          <div key={e.id} className="flex gap-3">
            <span className="mt-0.5 text-base">{ACTIVITY_ICONS[e.type]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] leading-5 text-white/75">{e.message}</p>
              <p className="mt-0.5 text-[10px] text-white/35">{e.actor} · {formatRelativeTime(e.timestamp)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set1PartPage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly"
      headerRight={<Badge className="border border-emerald-400/25 bg-emerald-400/15 text-[11px] text-emerald-400">Quoted</Badge>}>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <SpecGrid />
          <div className="col-span-2 space-y-3">
            <QuoteScatterChart />
            <QuoteTable />
          </div>
        </div>
        <ActivityLog />
      </div>
    </ConceptShell>
  );
}
