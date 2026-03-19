import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApprovedPartRequirement, JobAggregate } from "@/features/quotes/types";
import { InternalJobPartRequirementCard } from "./InternalJobPartRequirementCard";

type InternalJobRequirementsSectionProps = {
  cadPreviewSources: Map<string, ReturnType<typeof import("@/lib/cad-preview").createCadPreviewSourceFromJobFile>>;
  getDraftForPart: (part: JobAggregate["parts"][number]) => ApprovedPartRequirement;
  getQuoteQuantityInput: (partId: string, draft: ApprovedPartRequirement) => string;
  job: JobAggregate;
  jobRequestDefaults: {
    requested_service_kinds: string[];
    primary_service_kind: string | null;
    service_notes: string | null;
    requested_quote_quantities: number[];
    requested_by_date: string | null;
  };
  onDraftQuantityChange: (partId: string, draft: ApprovedPartRequirement, quantity: number) => void;
  onQuoteQuantityInputChange: (partId: string, value: string) => void;
  onQuoteQuantityInputCommit: (partId: string, draft: ApprovedPartRequirement) => void;
  updateDraft: (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => void;
  writeActionsDisabled: boolean;
};

export function InternalJobRequirementsSection({
  cadPreviewSources,
  getDraftForPart,
  getQuoteQuantityInput,
  job,
  jobRequestDefaults,
  onDraftQuantityChange,
  onQuoteQuantityInputChange,
  onQuoteQuantityInputCommit,
  updateDraft,
  writeActionsDisabled,
}: InternalJobRequirementsSectionProps) {
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Parts and approved requirements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {job.parts.map((part) => {
          const draft = getDraftForPart(part);

          return (
            <InternalJobPartRequirementCard
              key={part.id}
              part={part}
              draft={draft}
              quoteQuantityInput={getQuoteQuantityInput(part.id, draft)}
              cadPreviewSource={cadPreviewSources.get(part.id) ?? null}
              disabled={writeActionsDisabled}
              jobRequestDefaults={jobRequestDefaults}
              onDraftChange={(updater) => updateDraft(part.id, updater)}
              onDraftQuantityChange={(quantity) => onDraftQuantityChange(part.id, draft, quantity)}
              onQuoteQuantityInputChange={(value) => onQuoteQuantityInputChange(part.id, value)}
              onQuoteQuantityInputCommit={() => onQuoteQuantityInputCommit(part.id, draft)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
