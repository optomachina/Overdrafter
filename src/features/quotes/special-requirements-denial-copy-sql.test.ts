// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getXometryBetaScopeFailureMessage } from "./xometry-beta-dispatch";

/**
 * OVD-991: the customer copy for the special requirements and exact scope
 * denials is only truthful while it matches what the server resolvers check.
 * This test reads the latest definitions and fails when a resolver gains,
 * drops or moves a condition, so the copy is re-verified instead of drifting.
 * OVD-998 adds the quantity denials of the legacy Xometry resolver.
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
  const sql = normalize(readFileSync(`${MIGRATIONS}/${file}`, "utf8"));
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

/**
 * OVD-998 (OVD-987 P2): the legacy Xometry resolver (S1) denies quantity two ways. While the
 * user quantity switch is off, anything but exactly one quantity of 1 is
 * xometry_beta_quantity_one_required; once the switch exists (OVD-987 P3,
 * migration 20261020100000) that check also needs the switch off, and any
 * other count of quantities, one quantity of any size aside, is
 * xometry_beta_single_quantity_required. The second code does not exist until
 * that migration is in supabase/migrations, so its pin starts to bind when the
 * migration lands (the test then fails on any drift of the condition or copy).
 */
describe("xometry_beta quantity denials", () => {
  const { body } = latestDefinition("create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(");
  const hasUserQuantitySwitch = body.includes("private.xometry_beta_user_quantity_enabled()");
  const NORMALIZED_QUANTITIES =
    "public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity )";
  const oneQuantityCopy = getXometryBetaScopeFailureMessage({ message: "xometry_beta_quantity_one_required" });
  const singleQuantityCopy = getXometryBetaScopeFailureMessage({ message: "xometry_beta_single_quantity_required" });

  it("raises xometry_beta_quantity_one_required for anything but exactly [1] while the switch is off, as the copy says", () => {
    const raise = "raise exception 'xometry_beta_quantity_one_required'";
    expect(body.match(new RegExp(raise, "g"))).toHaveLength(1);
    expect(body).toContain(
      `if ${NORMALIZED_QUANTITIES} is distinct from array[1]::integer[]` +
        `${hasUserQuantitySwitch ? " and not private.xometry_beta_user_quantity_enabled()" : ""} then ${raise}`,
    );
    expect(oneQuantityCopy).toContain("quantity 1 only");
    expect(oneQuantityCopy).toContain("Set Qty to 1");
  });

  it("raises xometry_beta_single_quantity_required unless exactly one positive quantity remains, as the copy says", () => {
    const raise = "raise exception 'xometry_beta_single_quantity_required'";
    if (!hasUserQuantitySwitch) {
      // Before OVD-987 P3 the code is unreachable; the copy is staged for the migration.
      expect(body).not.toContain("xometry_beta_single_quantity_required");
      return;
    }
    expect(body.match(new RegExp(raise, "g"))).toHaveLength(1);
    expect(body).toContain(
      `if pg_catalog.cardinality(${NORMALIZED_QUANTITIES}) <> 1 then ${raise}`,
    );
    // Same place in the gate order: after the switch-off check, before the applicability check.
    const gate = (needle: string) => body.indexOf(needle);
    expect(gate("raise exception 'xometry_beta_quantity_one_required'")).toBeLessThan(gate(raise));
    expect(gate(raise)).toBeLessThan(gate("raise exception 'xometry_beta_xometry_applicability_required'"));
    // One quantity of any size is admitted, several are not, and so is none above zero.
    expect(singleQuantityCopy).toContain("one quantity per request");
    expect(singleQuantityCopy).toContain("exactly one quantity of 1 or more");
    expect(singleQuantityCopy).toContain("Remove extra Quote quantities");
    expect(singleQuantityCopy).not.toContain("quantity 1 only");
    expect(singleQuantityCopy).not.toContain("Set Qty to 1");
  });
});
