// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getXometryBetaScopeFailureMessage } from "./xometry-beta-dispatch";

/**
 * OVD-991: the customer copy for the special requirements and exact scope
 * denials is only truthful while it matches what the server resolvers check.
 * This test reads the latest definitions and fails when a resolver gains,
 * drops or moves a condition, so the copy is re-verified instead of drifting.
 */

const MIGRATIONS = "supabase/migrations";
const sqlFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ");
}

function latestDefinition(signature: string): { file: string; body: string } {
  const defining = sqlFiles.filter((name) =>
    readFileSync(`${MIGRATIONS}/${name}`, "utf8").includes(signature),
  );
  const file = defining.at(-1)!;
  const sql = normalize(readFileSync(`${MIGRATIONS}/${file}`, "utf8").replace(/--[^\n]*/g, ""));
  const start = sql.lastIndexOf(normalize(signature));
  // Function body: from the opening to the closing dollar quote.
  const open = sql.indexOf("$$", start);
  const end = sql.indexOf("$$", open + 2) + 2;
  return { file, body: sql.slice(start, end) };
}

function specialRequirementsBlock(body: string, code: string): string {
  const start = body.indexOf("v_special := coalesce(v_requirement.spec_snapshot");
  const end = body.indexOf(`raise exception '${code}'`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

// [what the resolver reads, how the copy names it]
const DENIED_SPECIAL_REQUIREMENTS: ReadonlyArray<readonly [string, string]> = [
  ["v_special ->> 'threads'", "Threads"],
  ["v_special ->> 'notes'", "Notes"],
  ["v_special ->> 'serviceNotes'", "service"],
  ["v_special #>> '{shipping,packagingNotes}'", "packaging"],
  ["v_special #>> '{shipping,shippingNotes}'", "shipping"],
  ["v_special #> '{certifications,requiredCertifications}'", "required certifications"],
  ["v_special #>> '{certifications,materialCertificationRequired}'", "material certification"],
  ["v_special #>> '{certifications,certificateOfConformanceRequired}'", "a certificate of conformance"],
  ["v_special #>> '{certifications,inspectionLevel}', 'standard') not in ('', 'standard')", "an inspection level other than Standard"],
  ["v_special #>> '{certifications,notes}'", "certification"],
  ["v_special #> '{sourcing,preferredSuppliers}'", "preferred suppliers"],
  ["v_special #>> '{sourcing,regionPreferenceOverride}', 'best_value') not in ('', 'best_value')", "a sourcing preference other than Best value"],
  ["v_special #>> '{sourcing,materialProvisioning}', 'supplier_to_source') not in ('', 'supplier_to_source')", "material provisioning other than Supplier to source"],
  ["v_special #>> '{sourcing,notes}'", "sourcing"],
  ["v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')", "a release hold or block"],
  ["v_special #>> '{release,notes}'", "release notes"],
];

describe.each([
  {
    label: "legacy Xometry resolver",
    signature: "create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(",
    code: "xometry_beta_special_requirements_not_supported",
    foldsNeedByIntoSpecialRequirements: false,
  },
  {
    label: "generic provider resolver",
    signature: "create or replace function private.resolve_provider_dispatch_scope(",
    code: "provider_dispatch_special_requirements_not_supported",
    foldsNeedByIntoSpecialRequirements: true,
  },
])("$label", ({ signature, code, foldsNeedByIntoSpecialRequirements }) => {
  const { body } = latestDefinition(signature);
  const block = specialRequirementsBlock(body, code);
  const message = getXometryBetaScopeFailureMessage({ message: code }, "fictiv");

  it("denies exactly the special requirements the copy names", () => {
    for (const [sqlFragment, copyFragment] of DENIED_SPECIAL_REQUIREMENTS) {
      expect(block, sqlFragment).toContain(sqlFragment);
      expect(message, copyFragment).toContain(copyFragment);
    }
    // A new condition must be added to the table above and to the copy.
    expect(block.match(/v_special (?:->>|#>>|#>) /g)).toHaveLength(DENIED_SPECIAL_REQUIREMENTS.length);
  });

  it("treats a requested delivery date the way the copy says", () => {
    expect(block.includes("v_requirement.requested_by_date is not null")).toBe(foldsNeedByIntoSpecialRequirements);
    expect(message.includes("Need by date")).toBe(foldsNeedByIntoSpecialRequirements);
    if (!foldsNeedByIntoSpecialRequirements) {
      expect(body).toContain("raise exception 'xometry_beta_special_delivery_date_not_supported'");
    }
  });
});

describe("provider_dispatch_exact_scope_required", () => {
  const { body } = latestDefinition("create or replace function private.resolve_provider_dispatch_scope(");

  it("is raised by the generic resolver only for a lane count other than one or a file mismatch", () => {
    const raises = body.match(/raise exception 'provider_dispatch_exact_scope_required'/g);
    expect(raises).toHaveLength(2);
    expect(body).toContain(
      "if (select count(*) from private.quote_lane_candidates( p_job_id, array[p_provider]::public.vendor_name[] )) <> 1 then raise exception 'provider_dispatch_exact_scope_required'",
    );
    expect(body).toContain("v_candidate.scope_snapshot #>> '{part,cad,sha256}' is distinct from v_cad.trusted_content_sha256");
  });

  it("does not require quantity 1, so the copy must not tell the customer to set Qty to 1", () => {
    expect(body).not.toContain("quote_quantities");
    expect(body).not.toContain("v_requirement.quantity");
    const candidates = latestDefinition("create or replace function private.quote_lane_candidates(").body;
    // One lane per Quote quantity: several quantities are what makes the count differ from one.
    expect(candidates).toContain("normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity)");
    const message = getXometryBetaScopeFailureMessage({ message: "provider_dispatch_exact_scope_required" }, "fictiv");
    expect(message).toContain("Remove extra Quote quantities");
    expect(message).not.toContain("Qty");
  });
});

// OVD-998: read the newest resolver, so a later quantity condition change requires copy review.
describe("quantity denial copy matches the latest resolver", () => {
  it("keeps quantity 1 only behind the disabled switch and otherwise requires one positive quantity", () => {
    const { body: sql } = latestDefinition("create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(");
    const start = sql.lastIndexOf("if public.normalize_positive_integer_array(");
    const end = sql.indexOf("if v_requirement.applicable_vendors", start);
    expect(sql.slice(start, end)).toBe(
      "if public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity ) is distinct from array[1]::integer[] and not private.xometry_beta_user_quantity_enabled() then raise exception 'xometry_beta_quantity_one_required'; end if; if pg_catalog.cardinality(public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity )) <> 1 then raise exception 'xometry_beta_single_quantity_required'; end if; ",
    );
    expect(getXometryBetaScopeFailureMessage({ message: "xometry_beta_quantity_one_required" })).toContain("quantity 1 only");
    expect(getXometryBetaScopeFailureMessage({ message: "xometry_beta_single_quantity_required" })).toContain("exactly one quantity of 1 or more");
  });
});

it("keeps the worker quantity note bound to the latest server switch refusal", () => {
  const { body } = latestDefinition("create or replace function public.api_authorize_xometry_beta_worker_dispatch(");
  const start = body.indexOf("if v_lane.requested_quantity <> 1 then");
  const end = body.indexOf("end if; end if;", start) + "end if; end if;".length;
  expect(body.slice(start, end)).toBe(
    "if v_lane.requested_quantity <> 1 then perform pg_catalog.pg_advisory_xact_lock_shared( pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0) ); if not private.xometry_beta_user_quantity_enabled() then return pg_catalog.jsonb_build_object( v_authorized_key, false, v_reason_key, 'dispatch_quantity_not_admitted' ); end if; end if;",
  );
});
