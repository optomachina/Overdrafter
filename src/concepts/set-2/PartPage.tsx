import { Hash, Folder, Package, Clock } from "lucide-react";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PARTS, MOCK_VENDOR_QUOTES } from "@/concepts/mock-data";
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

function IconRail() {
  const icons = [
    { Icon: Folder, label: "Projects", active: false },
    { Icon: Package, label: "Parts", active: true },
    { Icon: Clock, label: "History" },
    { Icon: Hash, label: "Vendors" },
  ];
  return (
    <div className="flex h-full flex-col items-center gap-2 py-3">
      {icons.map(({ Icon, label, active }) => (
        <button key={label} type="button" aria-label={label}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${active ? "bg-violet-500/20 text-violet-400" : "text-white/35 hover:bg-white/[0.06] hover:text-white/70"}`}>
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

function ShortcutHint({ keys }: { keys: string }) {
  return (
    <kbd className="rounded border border-white/[0.12] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40">{keys}</kbd>
  );
}

const part = MOCK_PARTS[0];
const chartData = MOCK_VENDOR_QUOTES.map((q) => ({
  x: q.leadTimeDays,
  y: q.price,
  vendor: q.vendor,
  tier: q.tier,
  selected: q.selected,
}));
const avgPrice = Math.round(MOCK_VENDOR_QUOTES.reduce((s, q) => s + q.price, 0) / MOCK_VENDOR_QUOTES.length);

type TooltipPayload = { payload?: { vendor: string; y: number; x: number; tier: string } };

function CommandTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.[0]?.payload) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded border border-violet-400/20 bg-[#0a0b0f] px-3 py-2 font-mono text-xs shadow-xl">
      <p className="text-violet-300">{d.vendor}</p>
      <p className="text-white/40">{d.tier}</p>
      <p className="mt-1 text-white/70">${d.y} · {d.x}d lead</p>
    </div>
  );
}

function QuoteScatterChart() {
  return (
    <div className="rounded-xl border border-violet-400/15 bg-[#070a0f] p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400/60">price_vs_lead_time</p>
        <ShortcutHint keys="⌘G" />
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <ScatterChart margin={{ top: 8, right: 20, bottom: 12, left: 8 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="rgba(167,139,250,0.07)" />
          <XAxis
            dataKey="x"
            type="number"
            name="lead"
            unit="d"
            tick={{ fill: "rgba(167,139,250,0.4)", fontSize: 10, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            domain={[4, 20]}
          />
          <YAxis
            dataKey="y"
            type="number"
            name="price"
            tick={{ fill: "rgba(167,139,250,0.4)", fontSize: 10, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${v}`}
            width={42}
          />
          <ReferenceLine y={avgPrice} stroke="rgba(167,139,250,0.2)" strokeDasharray="3 3"
            label={{ value: `avg`, position: "insideTopRight", fill: "rgba(167,139,250,0.35)", fontSize: 9, fontFamily: "monospace" }} />
          <Tooltip content={<CommandTooltip />} />
          <Scatter data={chartData} shape={(props: { cx?: number; cy?: number; payload?: typeof chartData[0] }) => {
            const { cx = 0, cy = 0, payload } = props;
            const isSelected = payload?.selected;
            const color = isSelected ? "#a78bfa" : "rgba(167,139,250,0.45)";
            return (
              <g>
                {isSelected && <circle cx={cx} cy={cy} r={9} fill="rgba(167,139,250,0.12)" stroke="rgba(167,139,250,0.5)" strokeWidth={1} />}
                <rect x={cx - 3} y={cy - 3} width={6} height={6} fill={color} transform={`rotate(45, ${cx}, ${cy})`} />
              </g>
            );
          }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function SpecPane() {
  const fields = [
    ["part_number", part.partNumber],
    ["revision", part.revision],
    ["material", part.material],
    ["finish", part.finish],
    ["tolerance", part.tolerance],
    ["quantity", String(part.quantity)],
    ["process", "CNC Machining"],
    ["status", "quoted"],
  ];

  return (
    <div className="h-full overflow-auto border-r border-white/[0.06] bg-[#080b0f] p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-400/60">Part Detail</p>
        <ShortcutHint keys="⌘I" />
      </div>
      <div className="space-y-2 font-mono">
        {fields.map(([key, value]) => (
          <div key={key} className="flex gap-3 text-[13px]">
            <span className="w-28 shrink-0 text-white/35">{key}</span>
            <span className="text-[13px] font-mono text-white/85">{value}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-[0.15em] text-white/30">Attached File</p>
        <code className="text-[11px] text-white/55">AHA-01093-C_RevC.pdf</code>
      </div>
    </div>
  );
}

function QuoteGrid() {
  return (
    <div className="flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-400/60">Quotes — {MOCK_VENDOR_QUOTES.length} received</p>
        <ShortcutHint keys="⌘R" />
      </div>
      <div className="mb-4">
        <QuoteScatterChart />
      </div>
      <div className="space-y-2">
        {MOCK_VENDOR_QUOTES.map((q, i) => (
          <div key={i}
            className={`flex items-center gap-4 rounded-xl border px-4 py-3 text-sm transition ${q.selected ? "border-violet-400/30 bg-violet-500/[0.08] ring-1 ring-violet-400/20" : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"}`}>
            <span className="w-5 shrink-0 font-mono text-[12px] text-white/25 tabular-nums">[{i + 1}]</span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-white/90">{q.vendor}</span>
                {q.selected && <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium text-violet-400">selected</span>}
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-white/35">{q.process} · {q.tier}</p>
            </div>
            {q.cert && (
              <span className="rounded border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-mono text-sky-400">{q.cert}</span>
            )}
            <div className="text-right">
              <p className="font-mono text-base font-semibold text-white">${q.price}</p>
              <p className="font-mono text-[11px] text-white/40">{q.leadTimeDays}d</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set2PartPage() {
  return (
    <ConceptShell sidebarContent={<IconRail />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly"
      headerRight={
        <div className="flex items-center gap-1.5">
          <code className="rounded-md border border-white/[0.10] bg-white/[0.05] px-2 py-0.5 font-mono text-[12px] text-violet-400">{part.partNumber}</code>
          <ShortcutHint keys="⌘⏎ select" />
        </div>
      }>
      <div className="flex h-full">
        <div className="w-72 shrink-0">
          <SpecPane />
        </div>
        <QuoteGrid />
      </div>
    </ConceptShell>
  );
}
