import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260406000000_add_extraction_quality_alerts.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

// ---------------------------------------------------------------------------
// Types for the TS-level semantic simulator
// ---------------------------------------------------------------------------

type SummaryRow = {
  organization_id: string;
  day: string;
  completed_extractions: number;
  model_fallback_rate: number;
  auto_approve_rate: number;
};

type AlertRow = {
  organization_id: string;
  alert_day: string;
  alert_type: string;
  metric_value: number;
  threshold_value: number;
};

// ---------------------------------------------------------------------------
// Pure TypeScript simulator of evaluate_extraction_quality_alerts().
// Mirrors the SQL function logic so we can test threshold semantics without a DB.
// ---------------------------------------------------------------------------

function evaluateAlerts(
  summary: SummaryRow[],
  day: string,
  existing: AlertRow[] = [],
): AlertRow[] {
  const inserted: AlertRow[] = [];

  const existingKeys = new Set(
    existing.map((a) => `${a.organization_id}:${a.alert_day}:${a.alert_type}`),
  );

  const conflictKey = (org: string, d: string, type: string) =>
    `${org}:${d}:${type}`;

  const addedKeys = new Set<string>();

  for (const row of summary) {
    if (row.day !== day || row.completed_extractions === 0) continue;

    if (row.model_fallback_rate > 0.3) {
      const key = conflictKey(row.organization_id, day, "model_fallback_rate_high");
      if (!existingKeys.has(key) && !addedKeys.has(key)) {
        inserted.push({
          organization_id: row.organization_id,
          alert_day: day,
          alert_type: "model_fallback_rate_high",
          metric_value: row.model_fallback_rate,
          threshold_value: 0.3,
        });
        addedKeys.add(key);
      }
    }

    if (row.auto_approve_rate < 0.7) {
      const key = conflictKey(row.organization_id, day, "auto_approve_rate_low");
      if (!existingKeys.has(key) && !addedKeys.has(key)) {
        inserted.push({
          organization_id: row.organization_id,
          alert_day: day,
          alert_type: "auto_approve_rate_low",
          metric_value: row.auto_approve_rate,
          threshold_value: 0.7,
        });
        addedKeys.add(key);
      }
    }
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Migration SQL structure tests
// ---------------------------------------------------------------------------

describe("extraction_quality_alerts migration", () => {
  it("creates the alerts table with the correct name and unique constraint", () => {
    expect(migrationSql).toContain(
      "create table if not exists public.extraction_quality_alerts",
    );
    expect(migrationSql).toContain(
      "unique (organization_id, alert_day, alert_type)",
    );
  });

  it("enables RLS and creates internal-only policies", () => {
    expect(migrationSql).toContain(
      "alter table public.extraction_quality_alerts enable row level security",
    );
    expect(migrationSql).toContain("extraction_quality_alerts_internal_select");
    expect(migrationSql).toContain("extraction_quality_alerts_manage_internal");
    expect(migrationSql).toContain("is_internal_user");
  });

  it("creates the evaluator function with correct name and default arg", () => {
    expect(migrationSql).toContain(
      "create or replace function public.evaluate_extraction_quality_alerts(",
    );
    expect(migrationSql).toContain("p_day date default (current_date - 1)");
  });

  it("uses both starting threshold values", () => {
    expect(migrationSql).toContain("model_fallback_rate_high");
    expect(migrationSql).toContain("0.3000");
    expect(migrationSql).toContain("auto_approve_rate_low");
    expect(migrationSql).toContain("0.7000");
  });

  it("uses on conflict do nothing for idempotent reruns", () => {
    expect(migrationSql).toContain(
      "on conflict (organization_id, alert_day, alert_type) do nothing",
    );
  });

  it("skips orgs with no extractions via completed_extractions > 0 guard", () => {
    expect(migrationSql).toContain("completed_extractions > 0");
  });
});

// ---------------------------------------------------------------------------
// Semantic / threshold logic tests
// ---------------------------------------------------------------------------

describe("evaluate_extraction_quality_alerts semantics", () => {
  const day = "2026-04-05";

  const baseRow = (
    overrides: Partial<SummaryRow> = {},
  ): SummaryRow => ({
    organization_id: "org-1",
    day,
    completed_extractions: 10,
    model_fallback_rate: 0.1,
    auto_approve_rate: 0.9,
    ...overrides,
  });

  it("fires model_fallback_rate_high when rate exceeds 0.30", () => {
    const alerts = evaluateAlerts([baseRow({ model_fallback_rate: 0.35 })], day);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe("model_fallback_rate_high");
    expect(alerts[0].metric_value).toBe(0.35);
    expect(alerts[0].threshold_value).toBe(0.3);
  });

  it("does not fire model_fallback_rate_high at exactly 0.30", () => {
    const alerts = evaluateAlerts([baseRow({ model_fallback_rate: 0.3 })], day);
    expect(alerts.every((a) => a.alert_type !== "model_fallback_rate_high")).toBe(true);
  });

  it("fires auto_approve_rate_low when rate is below 0.70", () => {
    const alerts = evaluateAlerts([baseRow({ auto_approve_rate: 0.65 })], day);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe("auto_approve_rate_low");
    expect(alerts[0].metric_value).toBe(0.65);
    expect(alerts[0].threshold_value).toBe(0.7);
  });

  it("does not fire auto_approve_rate_low at exactly 0.70", () => {
    const alerts = evaluateAlerts([baseRow({ auto_approve_rate: 0.7 })], day);
    expect(alerts.every((a) => a.alert_type !== "auto_approve_rate_low")).toBe(true);
  });

  it("fires both alerts simultaneously when both thresholds are breached", () => {
    const alerts = evaluateAlerts(
      [baseRow({ model_fallback_rate: 0.5, auto_approve_rate: 0.5 })],
      day,
    );
    const types = alerts.map((a) => a.alert_type);
    expect(types).toContain("model_fallback_rate_high");
    expect(types).toContain("auto_approve_rate_low");
    expect(alerts).toHaveLength(2);
  });

  it("produces no alerts when both metrics are within thresholds", () => {
    const alerts = evaluateAlerts(
      [baseRow({ model_fallback_rate: 0.2, auto_approve_rate: 0.8 })],
      day,
    );
    expect(alerts).toHaveLength(0);
  });

  it("skips orgs with completed_extractions = 0", () => {
    const alerts = evaluateAlerts(
      [baseRow({ completed_extractions: 0, model_fallback_rate: 0.9, auto_approve_rate: 0.1 })],
      day,
    );
    expect(alerts).toHaveLength(0);
  });

  it("only evaluates the requested day, ignoring other days", () => {
    const alerts = evaluateAlerts(
      [
        baseRow({ day: "2026-04-04", model_fallback_rate: 0.9 }),
        baseRow({ day, model_fallback_rate: 0.1, auto_approve_rate: 0.9 }),
      ],
      day,
    );
    expect(alerts).toHaveLength(0);
  });

  it("is idempotent: a second evaluation pass inserts 0 new alerts", () => {
    const summary = [baseRow({ model_fallback_rate: 0.5, auto_approve_rate: 0.5 })];
    const firstPass = evaluateAlerts(summary, day);
    expect(firstPass).toHaveLength(2);
    const secondPass = evaluateAlerts(summary, day, firstPass);
    expect(secondPass).toHaveLength(0);
  });

  it("handles multiple orgs independently on the same day", () => {
    const alerts = evaluateAlerts(
      [
        baseRow({ organization_id: "org-1", model_fallback_rate: 0.5 }),
        baseRow({ organization_id: "org-2", model_fallback_rate: 0.1 }),
      ],
      day,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].organization_id).toBe("org-1");
  });
});
