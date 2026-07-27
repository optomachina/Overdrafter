import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchSpendSummary, setGlobalSpendCap } from "@/features/quotes/api/platform-admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Spend observation and control.
 *
 * This surface configures and watches the cap; it does not enforce it. The
 * ceiling is applied in the worker at the point of spend, because a limit
 * checked when someone clicks a button cannot stop a retry storm or a stuck
 * loop — which is the shape a runaway bill actually takes.
 */

function usd(value: number | null | undefined) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  llm_extraction: "Drawing extraction (LLM)",
  vendor_automation: "Vendor automation",
};

export function SpendCapCard() {
  const queryClient = useQueryClient();
  const [dailyCeilingDraft, setDailyCeilingDraft] = useState("");

  const summaryQuery = useQuery({
    queryKey: ["admin", "spend-summary"],
    queryFn: () => fetchSpendSummary(),
    // Spend moves continuously; a stale ceiling reading is the one number here
    // that must not be trusted for long.
    refetchInterval: 60_000,
  });

  const mutation = useMutation({
    mutationFn: setGlobalSpendCap,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "spend-summary"] });
      setDailyCeilingDraft("");
      toast.success("Spend cap updated");
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not update the spend cap");
    },
  });

  const summary = summaryQuery.data;
  const spend = summary?.totalSpendUsd ?? 0;
  const ceiling = summary?.globalDailyCeilingUsd ?? 0;
  const usedPct = ceiling > 0 ? Math.min(100, (spend / ceiling) * 100) : 0;
  const killSwitchOn = summary?.killSwitch ?? false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Spend</CardTitle>
        {killSwitchOn ? (
          <Badge variant="destructive">Halted</Badge>
        ) : usedPct >= 80 ? (
          <Badge variant="destructive">{usedPct.toFixed(0)}% of ceiling</Badge>
        ) : (
          <Badge variant="secondary">{usedPct.toFixed(0)}% of ceiling</Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {summaryQuery.isError ? (
          <p className="text-sm text-destructive">
            Could not load spend. The cap is still enforced in the worker regardless of what this
            panel can display.
          </p>
        ) : null}

        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-semibold">{usd(spend)}</span>
            <span className="text-sm text-muted-foreground">
              of {usd(ceiling)} today (UTC) &middot; per-run cap {usd(summary?.perRunCeilingUsd)}
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={usedPct >= 80 ? "h-full bg-destructive" : "h-full bg-primary"}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>

        {summary && Object.keys(summary.byCategory ?? {}).length > 0 ? (
          <div className="space-y-1">
            {Object.entries(summary.byCategory).map(([category, amount]) => (
              <div key={category} className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                <span>{usd(amount)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {summary && summary.byOrganization?.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">By workspace</p>
            {summary.byOrganization.slice(0, 8).map((row) => (
              <div
                key={row.organizationId ?? "unattributed"}
                className="flex justify-between text-sm"
              >
                <span className="text-muted-foreground">
                  {row.organizationName ?? "Unattributed"}
                </span>
                <span>
                  {usd(row.spendUsd)}
                  {row.dailyCeilingUsd !== null && row.dailyCeilingUsd !== undefined
                    ? ` / ${usd(row.dailyCeilingUsd)}`
                    : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-t pt-4">
          <div className="grow">
            <Label htmlFor="daily-ceiling">Daily ceiling (USD)</Label>
            <Input
              id="daily-ceiling"
              inputMode="decimal"
              placeholder={ceiling ? ceiling.toFixed(2) : "50.00"}
              value={dailyCeilingDraft}
              onChange={(event) => setDailyCeilingDraft(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={mutation.isPending || !dailyCeilingDraft.trim()}
            onClick={() => {
              // Number() rejects a partial parse, unlike parseFloat, which would
              // read "25usd" as 25 and quietly set a ceiling nobody asked for.
              const rawValue = dailyCeilingDraft.trim();
              const parsed = Number(rawValue);
              if (!rawValue || !Number.isFinite(parsed) || parsed < 0) {
                toast.error("Enter a non-negative amount");
                return;
              }
              mutation.mutate({ dailyCeilingUsd: parsed });
            }}
          >
            Save
          </Button>
          <Button
            variant={killSwitchOn ? "default" : "destructive"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ killSwitch: !killSwitchOn })}
          >
            {killSwitchOn ? "Resume spending" : "Halt all spending"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Halting refuses new model calls and vendor lanes. Extraction continues on deterministic
          parsing alone, so uploads keep processing with more fields routed to review rather than
          stopping. Infrastructure billing (Supabase, Vercel, Cloud Run) is not visible here and
          needs provider-side caps.
        </p>
      </CardContent>
    </Card>
  );
}
