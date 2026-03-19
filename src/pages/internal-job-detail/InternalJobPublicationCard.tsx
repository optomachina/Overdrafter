import { ArrowUpRight, Loader2, Rocket, Send } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { PublishedPackageAggregate, QuoteRunAggregate, QuoteRunReadiness } from "@/features/quotes/types";

type InternalJobPublicationCardProps = {
  clientSummary: string;
  latestPackage: PublishedPackageAggregate | null;
  latestQuoteRun: QuoteRunAggregate | null;
  onClientSummaryChange: (value: string) => void;
  onPublish: () => void;
  publishPending: boolean;
  readiness: QuoteRunReadiness | undefined;
  writeActionsDisabled: boolean;
};

export function InternalJobPublicationCard({
  clientSummary,
  latestPackage,
  latestQuoteRun,
  onClientSummaryChange,
  onPublish,
  publishPending,
  readiness,
  writeActionsDisabled,
}: InternalJobPublicationCardProps) {
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Publication readiness</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!latestQuoteRun ? (
          <p className="text-sm text-white/55">
            Start a quote run after approving requirements to evaluate publication readiness.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
              <div>
                <p className="font-medium">Latest quote run</p>
                <p className="text-xs text-white/50">{latestQuoteRun.id}</p>
              </div>
              <Badge
                variant="secondary"
                className={
                  readiness?.ready
                    ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                    : "border border-amber-500/20 bg-amber-500/10 text-amber-300"
                }
              >
                {readiness?.ready ? "Auto-publish eligible" : "Internal approval required"}
              </Badge>
            </div>
            <Textarea
              className="min-h-28 border-white/10 bg-black/20"
              value={clientSummary}
              disabled={writeActionsDisabled}
              onChange={(event) => onClientSummaryChange(event.target.value)}
              placeholder="Client-facing summary"
            />
            <div className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-white/55">
              {readiness?.reasons?.length ? (
                readiness.reasons.map((reason) => <p key={reason}>{reason}</p>)
              ) : (
                <p>No blocking readiness issues detected.</p>
              )}
            </div>
            <Button
              className="w-full rounded-full"
              onClick={onPublish}
              disabled={writeActionsDisabled || !latestQuoteRun || publishPending}
            >
              {publishPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : readiness?.ready ? (
                <Rocket className="mr-2 h-4 w-4" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {readiness?.ready ? "Publish client package" : "Publish with internal approval"}
            </Button>
            {latestPackage ? (
              <Button asChild variant="outline" className="w-full border-white/10 bg-white/5">
                <Link to={`/client/packages/${latestPackage.id}`}>
                  Open latest client package
                  <ArrowUpRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
