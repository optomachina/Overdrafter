import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fetchOperationsStatus, OperationsStatusError } from "@/features/operations/operations-status-client";
import { OPERATIONS_REFRESH_MS, type OperationsItem } from "@/features/operations/contract";

const SEVERITIES = ["blocked", "attention", "unknown", "healthy"] as const;
const label = (text: string) => text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>Not reported</>;
}

/** Mounted only for a resolved platform-admin subject; authorization remains server-owned. */
export function OperationsStatusCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [accessDenied, setAccessDenied] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [now, setNow] = useState(Date.now);
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [subsystem, setSubsystem] = useState("all");
  const queryKey = ["admin-operations-status", userId] as const;
  const query = useQuery({
    queryKey, queryFn: ({ signal }) => fetchOperationsStatus(signal, userId),
    enabled: visible && !accessDenied, retry: false, staleTime: 0, gcTime: 0,
    refetchInterval: visible && !accessDenied ? OPERATIONS_REFRESH_MS : false, refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const denied = accessDenied || query.error instanceof OperationsStatusError && query.error.code === "access_denied";
  useEffect(() => {
    const key = ["admin-operations-status", userId];
    const update = () => {
      const nextVisible = document.visibilityState !== "hidden";
      setVisible(nextVisible); setNow(Date.now());
      if (!nextVisible) void queryClient.cancelQueries({ queryKey: key, exact: true });
    };
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [queryClient, userId]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    if (denied) {
      setAccessDenied(true);
      queryClient.removeQueries({ queryKey: ["admin-operations-status", userId], exact: true });
    }
  }, [denied, queryClient, userId]);

  const data = denied ? undefined : query.data;
  const effectiveSeverity = (item: OperationsItem) => query.isError || item.freshness.state !== "fresh"
    || !item.freshness.expiresAt || Date.parse(item.freshness.expiresAt) <= now ? "unknown" : item.severity;
  const items = [...(data?.items ?? [])].sort((left, right) =>
    SEVERITIES.indexOf(effectiveSeverity(left)) - SEVERITIES.indexOf(effectiveSeverity(right)) || left.key.localeCompare(right.key));
  const counts = Object.fromEntries(SEVERITIES.map((state) => [state, items.filter((item) => effectiveSeverity(item) === state).length]));
  const categories = [...new Set(items.map((item) => item.category))].sort();
  const subsystems = [...new Set(items.map((item) => item.provider ?? item.subsystem))].sort();
  const filtered = items.filter((item) => (severity === "all" || effectiveSeverity(item) === severity)
    && (category === "all" || item.category === category)
    && (subsystem === "all" || (item.provider ?? item.subsystem) === subsystem));
  const hasStale = items.some((item) => effectiveSeverity(item) === "unknown" && item.severity !== "unknown");

  return <section aria-labelledby="operations-title" className="mb-8 min-w-0">
    <Card className="border-border bg-muted">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="operations-title" className="text-2xl font-semibold">Operations</h2>
          <Button variant="outline" disabled={query.isFetching || !visible} onClick={() => { if (accessDenied) setAccessDenied(false); else void query.refetch({ cancelRefetch: false }); }}>
            {query.isFetching ? "Refreshing operations…" : "Refresh operations"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Read-only operational observations. Resolve conditions in their existing controls.</p>
        <p role="status" className="text-sm text-muted-foreground">
          {denied ? "Operations access unavailable." : query.isPending ? "Checking operational status…"
            : query.isError ? "Refresh unavailable. Prior observations are historical and shown as Unknown."
              : "Operational status loaded."}
        </p>
        <p className="text-sm">Last successful refresh: {data ? <Timestamp value={new Date(query.dataUpdatedAt).toISOString()} /> : "Not available"}</p>
        {hasStale ? <p className="text-sm">Some observations are stale. Their current status is Unknown until a fresh check succeeds.</p> : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SEVERITIES.map((state) => <div key={state} className="rounded border p-3"><dt>{label(state)}</dt><dd className="text-xl font-semibold">{data ? counts[state] : "—"}</dd></div>)}
        </dl>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm">Severity
            <select className="min-w-0 rounded border bg-background p-2" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="all">All severities</option>{SEVERITIES.map((state) => <option key={state} value={state}>{label(state)}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">Category
            <select className="min-w-0 rounded border bg-background p-2" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">All categories</option>{category !== "all" && !categories.includes(category as OperationsItem["category"]) ? <option value={category}>{label(category)} (not present)</option> : null}{categories.map((value) => <option key={value} value={value}>{label(value)}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">Provider or subsystem
            <select className="min-w-0 rounded border bg-background p-2" value={subsystem} onChange={(event) => setSubsystem(event.target.value)}>
              <option value="all">All providers and subsystems</option>{subsystem !== "all" && !(subsystems as string[]).includes(subsystem) ? <option value={subsystem}>{label(subsystem)} (not present)</option> : null}{subsystems.map((value) => <option key={value} value={value}>{label(value)}</option>)}
            </select>
          </label>
        </div>
        {data ? <p className="text-sm text-muted-foreground">Showing {filtered.length} of {items.length} observations.</p> : null}
        {data && filtered.length === 0 ? <p>{items.length ? "No items match these filters." : "No operational observations reported. Status is Unknown."}</p> : null}
        <ul className="space-y-3" aria-label="Operational observations">
          {filtered.map((item) => <li key={item.key} className="min-w-0 rounded border bg-background p-4 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{label(item.category)} · {label(item.provider ?? item.subsystem)}</h3>
              <Badge variant={effectiveSeverity(item) === "blocked" ? "destructive" : "outline"}>{label(effectiveSeverity(item))}</Badge>
            </div>
            <p className="mt-2 text-sm">{effectiveSeverity(item) !== item.severity ? "Prior observation: " : ""}{item.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">Reason: {label(item.reasonCode)} · Occurrences: {item.occurrenceCount ?? "Not reported"}</p>
            <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {Object.entries(item.context).filter(([name, value]) => value !== null && name !== "sessionEvidenceKind").map(([name, value]) => <div key={name}>
                <dt className="inline font-medium">{name === "sessionEvidenceAgeDays" ? "Session storage modified age (days)" : label(name)}: </dt>
                <dd className="inline">{name.startsWith("task") && name.endsWith("At") ? <Timestamp value={value as string} /> : value}</dd>
              </div>)}
              {([['First seen', item.firstSeenAt], ['Last seen', item.lastSeenAt], ['Changed', item.changedAt], ['Last checked', item.lastCheckedAt]] as const).map(([name, value]) => <div key={name}><dt className="inline font-medium">{name}: </dt><dd className="inline"><Timestamp value={value} /></dd></div>)}
            </dl>
            {item.context.sessionEvidenceKind === "storage_modified_age" ? <p className="mt-2 text-xs text-muted-foreground">Session age reflects storage modification time; it does not establish current authentication.</p> : null}
            {item.action?.kind === "spend_control" ? <a href="/internal/admin#spend-controls" className="mt-3 inline-block text-sm underline underline-offset-4">Open spend controls</a> : null}
          </li>)}
        </ul>
      </CardContent>
    </Card>
  </section>;
}
