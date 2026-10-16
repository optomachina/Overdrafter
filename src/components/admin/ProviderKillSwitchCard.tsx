import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  fetchProviderKillSwitches,
  PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH,
  setProviderKillSwitch,
  setProviderSettings,
  type ProviderKillSwitchRow,
} from "@/features/quotes/api/provider-kill-switch-api";
import { STEP_UP_ENROLL_TITLE, useAal2StepUp } from "@/features/auth/use-aal2-step-up";
import { MfaStepUpDialog } from "@/components/auth/MfaStepUpDialog";
import { StepUpNoticeBanner } from "@/components/auth/StepUpNoticeBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * OVD-722 provider kill switch. Stops all automated traffic to one provider,
 * or to every provider, with a data flip: the worker re-reads the switch
 * before launch and before each upload or configuration step, so the change
 * takes effect at the next checkpoint with no deploy. Every flip requires a
 * typed reason and a confirmation, and is audited. OVD-771: the write also
 * requires an AAL2 session; the emergency CLI uses the service role instead,
 * so the brake never depends on MFA.
 *
 * OVD-829: once the database returns each supplier's daily quote cap, the row
 * also edits it (a whole number, or unlimited). The worker reserves every
 * dispatch against that cap, so a change applies to the next quote.
 */

const QUERY_KEY = ["admin", "provider-kill-switches"] as const;
const GLOBAL_KEY = "all";

/** `expectedVersion` is the row version the admin saw when choosing to flip. */
type PendingFlip = {
  kind: "switch";
  provider: string | null;
  engaged: boolean;
  expectedVersion: number | null;
  /** The supplier's current cap, sent so the flip goes through the settings RPC (OVD-829). */
  dailyQuoteCap?: number | null;
};
type PendingCap = {
  kind: "cap";
  provider: string;
  engaged: boolean;
  dailyQuoteCap: number | null;
  expectedVersion: number | null;
};
type PendingChange = PendingFlip | PendingCap;
type WriteIntent = PendingChange & { reason: string };

type CapDraft = { value: string; unlimited: boolean };

function draftFor(cap: number | null): CapDraft {
  return cap === null ? { value: "", unlimited: true } : { value: String(cap), unlimited: false };
}

/** The cap a draft asks for: null for unlimited, a whole number above 0, or undefined when invalid. */
function draftCap(draft: CapDraft): number | null | undefined {
  if (draft.unlimited) return null;
  if (!/^\d+$/.test(draft.value.trim())) return undefined;
  const value = Number(draft.value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function formatCap(cap: number | null) {
  return cap === null ? "unlimited" : String(cap);
}

function writeIntent(intent: WriteIntent) {
  if (intent.kind === "cap") {
    const { kind: _kind, ...settings } = intent;
    return setProviderSettings(settings);
  }
  const { kind: _kind, ...flip } = intent;
  return setProviderKillSwitch(flip);
}

function formatChanged(row: Pick<ProviderKillSwitchRow, "changedAt" | "changedBy">) {
  if (!row.changedAt) return "Never changed";
  return `${new Date(row.changedAt).toLocaleString()} by ${row.changedBy ?? "unknown"}`;
}

function StateBadge({ engaged }: { engaged: boolean }) {
  return engaged ? <Badge variant="destructive">STOPPED</Badge> : <Badge variant="secondary">ALLOWED</Badge>;
}

export function ProviderKillSwitchCard() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [capDrafts, setCapDrafts] = useState<Record<string, CapDraft>>({});

  const stateQuery = useQuery({ queryKey: QUERY_KEY, queryFn: fetchProviderKillSwitches, refetchInterval: 60_000 });

  const mutation = useMutation({
    mutationFn: writeIntent,
    onSuccess: (_data, intent) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      if (intent.kind === "cap" && intent.provider) {
        const provider = intent.provider;
        setCapDrafts(({ [provider]: _saved, ...rest }) => rest);
      }
      setPending(null);
      setReason("");
      setConfirmation("");
      toast.success(intent.kind === "cap" ? "Daily cap updated" : "Kill switch updated");
    },
    onError: (error: unknown) => {
      // A refused stale release: show the current state before anyone retries.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.error(error instanceof Error ? error.message : "Could not update the kill switch");
    },
  });

  const stepUp = useAal2StepUp(mutation.mutateAsync);
  const isBusy = mutation.isPending || stepUp.isCheckingAssurance || stepUp.isMfaOpen;

  const begin = (change: PendingChange) => {
    setPending(change);
    setReason("");
    setConfirmation("");
  };

  const state = stateQuery.data;
  const expectedConfirmation = pending ? (pending.provider ?? GLOBAL_KEY) : "";
  const canConfirm = Boolean(pending)
    && reason.trim().length >= PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH
    && confirmation.trim() === expectedConfirmation
    && !isBusy;

  const toggle = (provider: string | null, engaged: boolean, version: number | null, dailyQuoteCap?: number | null) => (
    <Button
      variant="outline"
      size="sm"
      aria-label={`${engaged ? "Release" : "Stop"} ${provider ?? "all providers"}`}
      disabled={isBusy}
      onClick={() => begin({
        kind: "switch",
        provider,
        engaged: !engaged,
        expectedVersion: version,
        ...(dailyQuoteCap === undefined ? {} : { dailyQuoteCap }),
      })}
    >
      {engaged ? "Release" : "Stop"}
    </Button>
  );

  const capEditor = (row: ProviderKillSwitchRow) => {
    if (!row.settings) return <span className="text-sm text-muted-foreground">—</span>;
    const saved = row.settings.dailyQuoteCap;
    const draft = capDrafts[row.provider] ?? draftFor(saved);
    const next = draftCap(draft);
    const setDraft = (change: Partial<CapDraft>) =>
      setCapDrafts((drafts) => ({ ...drafts, [row.provider]: { ...draft, ...change } }));
    const unlimitedId = `daily-cap-unlimited-${row.provider}`;
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="h-8 w-20 font-mono tabular-nums"
            aria-label={`Daily quote cap for ${row.provider}`}
            value={draft.unlimited ? "" : draft.value}
            placeholder={draft.unlimited ? "∞" : undefined}
            disabled={draft.unlimited || isBusy}
            onChange={(event) => setDraft({ value: event.target.value })}
          />
          <div className="flex items-center gap-1">
            <Checkbox
              id={unlimitedId}
              checked={draft.unlimited}
              disabled={isBusy}
              onCheckedChange={(checked) => setDraft({
                unlimited: checked === true,
                value: checked === true ? draft.value : (draft.value || String(saved ?? 20)),
              })}
            />
            <Label htmlFor={unlimitedId} className="text-sm font-normal">Unlimited</Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Save daily cap for ${row.provider}`}
            disabled={isBusy || next === undefined || next === saved}
            onClick={() => next !== undefined && begin({
              kind: "cap",
              provider: row.provider,
              engaged: row.engaged,
              dailyQuoteCap: next,
              expectedVersion: row.version,
            })}
          >
            Save cap
          </Button>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {row.settings.usedToday} used today{saved === null ? " (unlimited)" : ` of ${saved}`}
        </p>
        {next === undefined ? (
          <p className="text-xs text-destructive">Enter a whole number above 0, or choose unlimited.</p>
        ) : null}
      </div>
    );
  };

  const showCaps = Boolean(state?.available && state.providers.some((row) => row.settings));

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
                {showCaps ? <TableHead>Daily quote cap</TableHead> : null}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">All providers (global)</TableCell>
                <TableCell><StateBadge engaged={state.global.engaged} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{state.global.reason ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatChanged(state.global)}</TableCell>
                {showCaps ? <TableCell className="text-sm text-muted-foreground">—</TableCell> : null}
                <TableCell className="text-right">{toggle(null, state.global.engaged, state.global.version)}</TableCell>
              </TableRow>
              {state.providers.map((row) => (
                <TableRow key={row.provider}>
                  <TableCell className="font-medium">{row.provider}</TableCell>
                  <TableCell><StateBadge engaged={row.engaged} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.reason ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatChanged(row)}</TableCell>
                  {showCaps ? <TableCell>{capEditor(row)}</TableCell> : null}
                  <TableCell className="text-right">
                    {toggle(row.provider, row.engaged, row.version, row.settings?.dailyQuoteCap)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {pending ? (
          <div
            className="space-y-3 border-t pt-4"
            role="group"
            aria-label={pending.kind === "cap" ? "Confirm daily cap change" : "Confirm kill switch change"}
          >
            <p className="text-sm font-medium">
              {pending.kind === "cap"
                ? `Set the daily quote cap for ${pending.provider} to ${formatCap(pending.dailyQuoteCap)}`
                : `${pending.engaged ? "Stop all automated traffic to" : "Release"} ${pending.provider ?? "every provider (global switch)"}`}
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
                variant={pending.kind === "switch" && pending.engaged ? "destructive" : "default"}
                disabled={!canConfirm}
                onClick={() => void stepUp.requestWrite({ ...pending, reason })}
              >
                Confirm
              </Button>
              <Button variant="ghost" disabled={isBusy} onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <StepUpNoticeBanner notice={stepUp.notice} onEnroll={stepUp.startEnrollment} />
      </CardContent>
      <MfaStepUpDialog
        {...stepUp.dialogProps}
        title={stepUp.dialogMode === "enroll" ? STEP_UP_ENROLL_TITLE : "Verify this kill switch change"}
        description="Stopping or releasing provider traffic requires an authenticator-app code. Your account remains the audited actor. If MFA is unavailable in an emergency, use the provider:kill CLI (see the cease-and-desist runbook)."
      />
    </Card>
  );
}
