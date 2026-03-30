import { AlertTriangle, FolderOpen, Activity, CheckCircle2, Clock, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PARTS, MOCK_VENDOR_QUOTES, MOCK_ACTIVITY, formatRelativeTime, type PartStatus } from "@/concepts/mock-data";

const STATUS_BAR: Record<PartStatus, string> = {
  quoted: "bg-emerald-500",
  selected: "bg-sky-500",
  requesting: "bg-amber-500",
  needs_attention: "bg-rose-500",
};

const STATUS_LABEL: Record<PartStatus, string> = {
  quoted: "Quoted",
  selected: "Selected",
  requesting: "Quoting",
  needs_attention: "Needs Attention",
};

const STATUS_TEXT: Record<PartStatus, string> = {
  quoted: "text-emerald-400",
  selected: "text-sky-400",
  requesting: "text-amber-400",
  needs_attention: "text-rose-400",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Navigation</p>
      {[
        { Icon: Activity, label: "Dashboard" },
        { Icon: FolderOpen, label: "Projects", active: true },
        { Icon: AlertTriangle, label: "Alerts", badge: "2" },
      ].map(({ Icon, label, active, badge }) => (
        <button key={label} type="button"
          className={`flex items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-white/[0.06] ${active ? "bg-pink-500/[0.10] text-pink-400" : "text-white/60"}`}>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </div>
          {badge && <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] text-rose-400">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];
const medianPrice = 498;

type HealthDot = "good" | "warn" | "bad";

function getPriceDot(price: number): HealthDot {
  if (price <= medianPrice * 0.95) return "good";
  if (price <= medianPrice * 1.1) return "warn";
  return "bad";
}

function getLeadDot(days: number): HealthDot {
  if (days <= 10) return "good";
  if (days <= 15) return "warn";
  return "bad";
}

const DOT_COLORS: Record<HealthDot, string> = {
  good: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-rose-400",
};

function HealthDotIndicator({ dot }: { dot: HealthDot }) {
  return <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${DOT_COLORS[dot]}`} />;
}

function QuoteHealthRow({ quote, index }: { quote: typeof MOCK_VENDOR_QUOTES[0]; index: number }) {
  const priceDot = getPriceDot(quote.price);
  const leadDot = getLeadDot(quote.leadTimeDays);

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
      quote.selected
        ? "border-emerald-400/25 bg-emerald-400/[0.07] ring-1 ring-emerald-400/15"
        : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
    }`}>
      <span className="w-5 shrink-0 font-mono text-[12px] text-white/25 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {quote.selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
          <span className="text-sm font-medium text-white/90">{quote.vendor}</span>
          {quote.cert && (
            <span className="rounded border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-mono text-sky-400">
              {quote.cert}
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-white/35">{quote.process} · {quote.tier}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <HealthDotIndicator dot={priceDot} />
            <span className="font-mono text-sm font-semibold text-white">${quote.price}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <HealthDotIndicator dot={leadDot} />
            <span className="font-mono text-[11px] text-white/40">{quote.leadTimeDays}d lead</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpecPanel() {
  const fields: Array<[string, string, boolean]> = [
    ["Part Number", part.partNumber, true],
    ["Revision", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Quantity", String(part.quantity), false],
  ];

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Specifications</p>
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

function ActionSection() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Actions</p>
      <div className="space-y-2">
        <Button size="sm" className="w-full justify-start gap-2 rounded-xl bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-400/20">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Select Vendor
        </Button>
        <Button size="sm" variant="outline" className="w-full justify-start gap-2 rounded-xl border-white/[0.10] bg-white/[0.03] text-white/60 hover:bg-white/[0.06]">
          <TrendingDown className="h-3.5 w-3.5" />
          Request Re-quote
        </Button>
      </div>
    </div>
  );
}

function AlertLog() {
  const alerts = [
    { type: "warn" as const, message: "Drawing rev C uploaded — specs auto-extracted, verify tolerance callout", time: "2026-03-22T09:20:00Z" },
    { type: "info" as const, message: "5 vendor quotes received — median price $498, best $431", time: "2026-03-23T16:55:00Z" },
  ];

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Alert Log</p>
      <div className="space-y-2">
        {alerts.map((a, i) => (
          <div key={i} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
            a.type === "warn"
              ? "border-amber-400/20 bg-amber-400/[0.06]"
              : "border-sky-400/15 bg-sky-400/[0.05]"
          }`}>
            <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${a.type === "warn" ? "text-amber-400" : "text-sky-400"}`} />
            <div>
              <p className="text-[12px] leading-5 text-white/70">{a.message}</p>
              <p className="mt-0.5 text-[10px] text-white/30">{formatRelativeTime(a.time)}</p>
            </div>
          </div>
        ))}
        {MOCK_ACTIVITY.filter((e) => e.type === "spec_updated").map((e) => (
          <div key={e.id} className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/25" />
            <div>
              <p className="text-[12px] leading-5 text-white/55">{e.message}</p>
              <p className="mt-0.5 text-[10px] text-white/30">{e.actor} · {formatRelativeTime(e.timestamp)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set5PartPage() {
  const statusBarColor = STATUS_BAR[part.status];
  const statusText = STATUS_TEXT[part.status];
  const statusLabel = STATUS_LABEL[part.status];

  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly"
      headerRight={
        <Badge className={`border text-[10px] ${statusText} border-current/25 bg-current/10`}>{statusLabel}</Badge>
      }>
      <div className="flex flex-col">
        <div className={`h-1.5 w-full ${statusBarColor}`} />
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] bg-ws-inset px-5 py-3">
          <div className="flex items-center gap-3">
            <code className="font-mono text-lg font-semibold text-white">{part.partNumber}</code>
            <span className="text-white/35">·</span>
            <span className="text-sm text-white/55">{part.revision}</span>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-white/40">
            <span>Median: <span className="font-mono text-white/60">${medianPrice}</span></span>
            <span>·</span>
            <span>Target lead: <span className="font-mono text-white/60">10d</span></span>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-4 p-4">
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                Quote Options — {MOCK_VENDOR_QUOTES.length} received
              </p>
              <div className="mb-2 flex items-center gap-4 text-[11px] text-white/35">
                <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-emerald-400" /> below median</div>
                <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-amber-400" /> near median</div>
                <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-rose-400" /> above median</div>
              </div>
              {MOCK_VENDOR_QUOTES.map((q, i) => (
                <QuoteHealthRow key={i} quote={q} index={i} />
              ))}
            </div>
            <div className="space-y-3">
              <SpecPanel />
              <ActionSection />
              <AlertLog />
            </div>
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
