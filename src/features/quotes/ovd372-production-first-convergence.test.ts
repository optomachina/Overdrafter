import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const evaluatorRestriction = readFileSync(
  path.resolve(
    process.cwd(),
    "supabase/migrations/20260816015000_restrict_extraction_quality_alert_evaluator.sql",
  ),
  "utf8",
);
const quoteContractRepair = readFileSync(
  path.resolve(
    process.cwd(),
    "supabase/migrations/20260816015500_restore_production_first_quote_contracts.sql",
  ),
  "utf8",
);
const pendingHeadManifest = JSON.parse(
  readFileSync(
    path.resolve(
      process.cwd(),
      "docs/release/ovd-372-pending-head-manifest.json",
    ),
    "utf8",
  ),
) as { productionHistoryReconciliations?: string[] };
const productionPreconditions = readFileSync(
  path.resolve(
    process.cwd(),
    "scripts/verify-ovd372-production-preconditions.sql",
  ),
  "utf8",
);

describe("OVD-372 production-first convergence migrations", () => {
  it("limits deferred extraction alert evaluation to service_role", () => {
    expect(evaluatorRestriction).toContain(
      "revoke all on function public.evaluate_extraction_quality_alerts(date)",
    );
    expect(evaluatorRestriction).toContain("from public, anon, authenticated");
    expect(evaluatorRestriction).toContain(
      "grant execute on function public.evaluate_extraction_quality_alerts(date)",
    );
    expect(evaluatorRestriction).toContain("to service_role");
  });

  it("repairs only the two catalog-proven quote contracts", () => {
    expect(quoteContractRepair).toContain(
      "private.request_automatic_quote_impl(uuid,boolean)",
    );
    expect(quoteContractRepair).toContain(
      "public.api_list_client_quote_workspace(uuid[])",
    );
    expect(quoteContractRepair).toContain("serviceRequestLineItemId");
    expect(quoteContractRepair).toContain("invalidated_by");
    expect(quoteContractRepair).toContain("invalidation_reason");
    expect(quoteContractRepair).toContain(
      "run.request_service_request_line_item_id = run.canonical_service_request_line_item_id",
    );
    expect(quoteContractRepair).not.toContain("run.request_service_line_item_id");
    expect(quoteContractRepair).not.toMatch(/\b(create|alter|drop)\s+table\b/i);
  });

  it("fails closed when either expected function shape is unavailable", () => {
    expect(quoteContractRepair).toContain(
      "Unable to locate the legacy vendor-task payload contract.",
    );
    expect(quoteContractRepair).toContain(
      "Unable to restore service-request lineage in vendor tasks.",
    );
    expect(quoteContractRepair).toContain(
      "Unable to restore the client quote workspace contract.",
    );
  });

  it("never replays the superseded automatic-quote migration in production", () => {
    expect(pendingHeadManifest.productionHistoryReconciliations).toEqual([
      "20260402100000",
      "20260403103000",
      "20260406000000",
      "20260408193000",
      "20260731015400",
    ]);
  });

  it("pins the live catalog and exact reconciliation set before production repair", () => {
    expect(productionPreconditions).toContain("20260813005020");
    for (const version of pendingHeadManifest.productionHistoryReconciliations ?? []) {
      expect(productionPreconditions).toContain(version);
    }
    expect(productionPreconditions).toContain("pg_catalog.pg_get_functiondef");
    expect(productionPreconditions).toContain("pg_catalog.aclexplode");
    expect(productionPreconditions).toContain("owner_role.rolname");
    expect(productionPreconditions).toContain("table_row.relrowsecurity");
    expect(productionPreconditions).toContain("pg_catalog.pg_get_constraintdef");
    expect(productionPreconditions).toContain("pg_catalog.pg_policies");
    expect(productionPreconditions).toContain("pg_catalog.pg_get_triggerdef");
    expect(productionPreconditions).toContain("job_vendor_preferences");
    expect(productionPreconditions).toContain("project_vendor_preferences");
    expect(productionPreconditions).toContain("public.api_request_quote(uuid,boolean)");
    expect(productionPreconditions).toContain(
      "public.api_list_client_quote_workspace(uuid[])",
    );
  });
});
