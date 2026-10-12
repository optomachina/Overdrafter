import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  fetchProviderKillSwitches,
  PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH,
  setProviderKillSwitch,
  type ProviderKillSwitchRow,
} from "@/features/quotes/api/provider-kill-switch-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * OVD-722 provider kill switch. Stops all automated traffic to one provider,
 * or to every provider, with a data flip: the worker re-reads the switch
 * before launch and before each upload or configuration step, so the change
 * takes effect at the next checkpoint with no deploy. Every flip requires a
 * typed reason and a confirmation, and is audited.
 */

const QUERY_KEY = ["admin", "provider-kill-switches"] as const;
const GLOBAL_KEY = "all";

/** `expectedVersion` is the row version the admin saw when choosing to flip. */
type PendingFlip = { provider: string | null; engaged: boolean; expectedVersion: number | null };

function formatChanged(row: Pick<ProviderKillSwitchRow, "changedAt" | "changedBy">) {
  if (!row.changedAt) return "Never changed";
  return `${new Date(row.changedAt).toLocaleString()} by ${row.changedBy ?? "unknown"}`;
}

function StateBadge({ engaged }: { engaged: boolean }) {
  return engaged ? <Badge variant="destructive">STOPPED</Badge> : <Badge variant="secondary">ALLOWED</Badge>;
}

export function ProviderKillSwitchCard() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingFlip | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const stateQuery = useQuery({ queryKey: QUERY_KEY, queryFn: fetchProviderKillSwitches, refetchInterval: 60_000 });

  const mutation = useMutation({
    mutationFn: setProviderKillSwitch,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setPending(null);
      setReason("");
      setConfirmation("");
      toast.success("Kill switch updated");
    },
    onError: (error: unknown) => {
      // A refused stale release: show the current state before anyone retries.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.error(error instanceof Error ? error.message : "Could not update the kill switch");
    },
  });

  const begin = (flip: PendingFlip) => {
    setPending(flip);
    setReason("");
    setConfirmation("");
  };

  const state = stateQuery.data;
  const expectedConfirmation = pending ? (pending.provider ?? GLOBAL_KEY) : "";
  const canConfirm = Boolean(pending)
    && reason.trim().length >= PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH
    && confirmation.trim() === expectedConfirmation
    && !mutation.isPending;

  const toggle = (provider: string | null, engaged: boolean, version: number | null) => (
    <Button
      variant="outline"
      size="sm"
      aria-label={`${engaged ? "Release" : "Stop"} ${provider ?? "all providers"}`}
      disabled={mutation.isPending}
      onClick={() => begin({ provider, engaged: !engaged, expectedVersion: version })}
    >
      {engaged ? "Release" : "Stop"}
    </Button>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Provider kill switch</CardTitle>
        {state?.available ? <StateBadge engaged={state.global.engaged} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {stateQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading switch state…</p> : null}
        {stateQuery.isError ? (
          <p className="text-sm text-destructive">
            Could not load the kill switch state. The worker refuses provider traffic whenever it cannot read the switch.
          </p>
        ) : null}
        {state && !state.available ? (
          <p className="text-sm text-muted-foreground">
            The kill switch is not installed yet (OVD-722 migration pending).
          </p>
        ) : null}

        {state?.available ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last reason</TableHead>
                <TableHead>Changed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">All providers (global)</TableCell>
                <TableCell><StateBadge engaged={state.global.engaged} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{state.global.reason ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatChanged(state.global)}</TableCell>
                <TableCell className="text-right">{toggle(null, state.global.engaged, state.global.version)}</TableCell>
              </TableRow>
              {state.providers.map((row) => (
                <TableRow key={row.provider}>
                  <TableCell className="font-medium">{row.provider}</TableCell>
                  <TableCell><StateBadge engaged={row.engaged} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.reason ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatChanged(row)}</TableCell>
                  <TableCell className="text-right">{toggle(row.provider, row.engaged, row.version)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {pending ? (
          <div className="space-y-3 border-t pt-4" role="group" aria-label="Confirm kill switch change">
            <p className="text-sm font-medium">
              {pending.engaged ? "Stop all automated traffic to" : "Release"}{" "}
              {pending.provider ?? "every provider (global switch)"}
            </p>
            <div>
              <Label htmlFor="kill-switch-reason">Reason (at least {PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH} characters)</Label>
              <Input id="kill-switch-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="kill-switch-confirmation">Type “{expectedConfirmation}” to confirm</Label>
              <Input
                id="kill-switch-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant={pending.engaged ? "destructive" : "default"}
                disabled={!canConfirm}
                onClick={() => mutation.mutate({
                  provider: pending.provider,
                  engaged: pending.engaged,
                  reason,
                  expectedVersion: pending.expectedVersion,
                })}
              >
                Confirm
              </Button>
              <Button variant="ghost" disabled={mutation.isPending} onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
