import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260323194500_add_extraction_quality_summary.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

type AuditEventFixture = {
  organization_id: string;
  created_at: string;
  event_type: string;
  payload: Record<string, unknown>;
};

function summarizeExtractionQuality(events: AuditEventFixture[]) {
  const filtered = events.filter((event) => event.event_type === "worker.extraction_completed");
  const groups = new Map<
    string,
    {
      organization_id: string;
      day: string;
      completed_extractions: number;
      auto_approved_extractions: number;
      needs_review_extractions: number;
      partial_lifecycle_extractions: number;
      warning_extractions: number;
      model_fallback_extractions: number;
    }
  >();

  for (const event of filtered) {
    const day = event.created_at.slice(0, 10);
    const key = `${event.organization_id}:${day}`;
    const current = groups.get(key) ?? {
      organization_id: event.organization_id,
      day,
      completed_extractions: 0,
      auto_approved_extractions: 0,
      needs_review_extractions: 0,
      partial_lifecycle_extractions: 0,
      warning_extractions: 0,
      model_fallback_extractions: 0,
    };

    current.completed_extractions += 1;
    if (event.payload.autoApproved === true) current.auto_approved_extractions += 1;
    if (event.payload.extractionStatus === "needs_review") current.needs_review_extractions += 1;
    if (event.payload.extractionLifecycle === "partial") current.partial_lifecycle_extractions += 1;
    if (typeof event.payload.warningCount === "number" && event.payload.warningCount > 0) {
      current.warning_extractions += 1;
    }
    if (event.payload.modelFallbackUsed === true) current.model_fallback_extractions += 1;
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    auto_approve_rate:
      group.completed_extractions === 0
        ? 0
        : Number((group.auto_approved_extractions / group.completed_extractions).toFixed(4)),
    model_fallback_rate:
      group.completed_extractions === 0
        ? 0
        : Number((group.model_fallback_extractions / group.completed_extractions).toFixed(4)),
  }));
}

describe("extraction_quality_summary migration", () => {
  it("creates the summary view from immutable audit events", () => {
    expect(migrationSql).toContain("create or replace view public.extraction_quality_summary as");
    expect(migrationSql).toContain("from public.audit_events");
    expect(migrationSql).toContain("where event_type = 'worker.extraction_completed'");
    expect(migrationSql).toContain("timezone('utc', created_at)::date as day");
    expect(migrationSql).not.toContain("from public.drawing_extractions");
  });

  it("defines the expected counters and zero-safe rounded rates", () => {
    expect(migrationSql).toContain("auto_approved_extractions");
    expect(migrationSql).toContain("needs_review_extractions");
    expect(migrationSql).toContain("partial_lifecycle_extractions");
    expect(migrationSql).toContain("warning_extractions");
    expect(migrationSql).toContain("model_fallback_extractions");
    expect(migrationSql).toContain("round(");
    expect(migrationSql).toContain("nullif(count(*)::numeric, 0)");
    expect(migrationSql).toContain("coalesce(");
  });
});

describe("extraction quality summary semantics", () => {
  it("groups by UTC day and computes counters and rates from completed runs only", () => {
    const summary = summarizeExtractionQuality([
      {
        organization_id: "org-1",
        created_at: "2026-03-20T23:50:00.000Z",
        event_type: "worker.extraction_completed",
        payload: {
          autoApproved: true,
          extractionStatus: "approved",
          extractionLifecycle: "succeeded",
          warningCount: 0,
          modelFallbackUsed: false,
        },
      },
      {
        organization_id: "org-1",
        created_at: "2026-03-20T23:59:59.000Z",
        event_type: "worker.extraction_failed",
        payload: {
          autoApproved: false,
          modelFallbackUsed: true,
        },
      },
      {
        organization_id: "org-1",
        created_at: "2026-03-21T00:05:00.000Z",
        event_type: "worker.extraction_completed",
        payload: {
          autoApproved: false,
          extractionStatus: "needs_review",
          extractionLifecycle: "partial",
          warningCount: 2,
          modelFallbackUsed: true,
        },
      },
      {
        organization_id: "org-1",
        created_at: "2026-03-21T12:00:00.000Z",
        event_type: "worker.extraction_completed",
        payload: {
          autoApproved: true,
          extractionStatus: "approved",
          extractionLifecycle: "partial",
          warningCount: 1,
          modelFallbackUsed: false,
        },
      },
    ]);

    expect(summary).toEqual([
      {
        organization_id: "org-1",
        day: "2026-03-20",
        completed_extractions: 1,
        auto_approved_extractions: 1,
        needs_review_extractions: 0,
        partial_lifecycle_extractions: 0,
        warning_extractions: 0,
        model_fallback_extractions: 0,
        auto_approve_rate: 1,
        model_fallback_rate: 0,
      },
      {
        organization_id: "org-1",
        day: "2026-03-21",
        completed_extractions: 2,
        auto_approved_extractions: 1,
        needs_review_extractions: 1,
        partial_lifecycle_extractions: 2,
        warning_extractions: 2,
        model_fallback_extractions: 1,
        auto_approve_rate: 0.5,
        model_fallback_rate: 0.5,
      },
    ]);
  });
});
