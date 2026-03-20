import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatStatusLabel } from "@/features/quotes/utils";
import type { JobAggregate } from "@/features/quotes/types";

type InternalJobOverviewSectionProps = {
  job: JobAggregate;
};

export function InternalJobOverviewSection({ job }: InternalJobOverviewSectionProps) {
  return (
    <>
      {job.job.tags.length > 0 ? (
        <section className="mb-6 flex flex-wrap gap-2">
          {job.job.tags.map((tag) => (
            <Badge
              key={`${job.job.id}-${tag}`}
              variant="secondary"
              className="border border-primary/20 bg-primary/10 text-primary"
            >
              {tag}
            </Badge>
          ))}
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Job status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/80">
              {formatStatusLabel(job.job.status)}
            </Badge>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Parts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.parts.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Files</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.files.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Pricing policy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{job.pricingPolicy?.version ?? "v1_markup_20"}</p>
            <p className="mt-1 text-sm text-white/55">{job.pricingPolicy?.markup_percent ?? 20}% markup</p>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
