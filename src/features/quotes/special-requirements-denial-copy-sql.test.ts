// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClientPartRequestUpdateInput } from "./types";
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

function latestDefinition(
  signature: string,
  sources = sqlFiles.map((file) => ({ file, sql: readFileSync(`${MIGRATIONS}/${file}`, "utf8") })),
): { file: string; body: string } {
  const name = signature.match(/private\.(\w+)/i)![1];
  const declaration = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+private\\s*\\.\\s*${name}\\b`, "gi");
  const definition = new RegExp(`${declaration.source}\\s*\\([\\s\\S]*?\\bas\\s+(\\$(?:[a-z_][a-z_0-9]*)?\\$)([\\s\\S]*?)\\1`, "gi");
  let latest: { file: string; body: string } | undefined;
  for (const { file, sql } of sources) {
    const declarations = [...sql.matchAll(declaration)];
    const definitions = [...sql.matchAll(definition)];
    if (declarations.length !== definitions.length) {
      throw new Error(`Unmatched definition of ${name} in ${file}`);
    }
    const match = definitions.at(-1);
    if (match) latest = { file, body: normalize(match[0]) };
  }
  if (!latest) throw new Error(`No definition of ${name}`);
  return latest;
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
  ["v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')", "a saved release hold or block (contact support)"],
  ["v_special #>> '{release,notes}'", "release notes"],
];

const allSetRequest: Partial<ClientPartRequestUpdateInput> = {
  threads: "M8", notes: "Deburr", serviceNotes: "Service", requestedByDate: "2030-01-01",
  shipping: { packagingNotes: "Wrap", shippingNotes: "Ship", requestedByDateOverride: null },
  certifications: { requiredCertifications: ["ISO"], materialCertificationRequired: true,
    certificateOfConformanceRequired: true, inspectionLevel: "fai", notes: "Cert" },
  sourcing: { preferredSuppliers: ["Supplier"], regionPreferenceOverride: "domestic_only",
    materialProvisioning: "customer_supplied", notes: "Source" },
  // Legacy server status; the customer form cannot set a hold or block.
  release: { releaseStatus: "hold" as never, reviewDisposition: null, quoteBlockedUntilRelease: null, notes: "Release" },
};

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
  const message = getXometryBetaScopeFailureMessage({ message: code }, "fictiv", { request: allSetRequest });

  it("denies exactly the special requirements the copy names", () => {
    for (const [sqlFragment, copyFragment] of DENIED_SPECIAL_REQUIREMENTS) {
      expect(block, sqlFragment).toContain(sqlFragment);
      expect(message, copyFragment).toContain(copyFragment);
    }
    // A new condition must be added to the table above and to the copy.
    expect(block.match(/v_special\s*(?:->>|#>>|#>)\s*/gi)).toHaveLength(DENIED_SPECIAL_REQUIREMENTS.length);
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
    expect(candidates).toContain("selected_vendor.vendor = any(requirement.applicable_vendors)");
    expect(candidates).toContain("from public.parts part");
    expect(candidates).toContain("where part.job_id = p_job_id");
    expect(message).toContain("provider applies to this part");
    expect(message).toContain("one part and one Quote quantity");
    expect(message).toContain("approved files must also match");
    expect(message).not.toContain("Qty");
  });
});


describe("latest SQL definition matcher (OVD-995)", () => {
  const signature = "create or replace function private.resolve_provider_dispatch_scope(";
  it("catches a later uppercase, multiline, tagged-dollar mutant the old matcher missed", () => {
    const dir = mkdtempSync(".ovd995-sql-");
    const file = `${dir}/99999999999999_mutant.sql`;
    const sql = "CREATE OR REPLACE\n FUNCTION private . resolve_provider_dispatch_scope (p_job_id uuid) RETURNS void LANGUAGE plpgsql AS $function$ BEGIN PERFORM v_special->>'mutant'; END; $function$;";
    try {
      writeFileSync(file, sql);
      const scratch = readFileSync(file, "utf8");
      expect(scratch.includes(signature)).toBe(false);
      const latest = latestDefinition(signature, [
        { file: "earlier.sql", sql: `${signature}) returns void as $$ begin end; $$;` },
        { file, sql: scratch },
      ]);
      expect(latest.file).toBe(file);
      expect(latest.body).toContain("v_special->>'mutant'");
      expect(latest.body.match(/v_special (?:->>|#>>|#>) /g)).toBeNull();
      expect(latest.body.match(/v_special\s*(?:->>|#>>|#>)\s*/gi)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("fails closed when a later declaration has no matched body", () => {
    expect(() => latestDefinition(signature, [
      { file: "later.sql", sql: `${signature}) returns void as $function$ unterminated` },
    ])).toThrow("Unmatched definition");
  });
});
