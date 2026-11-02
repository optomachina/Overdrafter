// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUESTED_SERVICE_TYPE_OPTIONS } from "./service-intent";
import { getXometryBetaScopeFailureMessage } from "./xometry-beta-dispatch";

/**
 * OVD-991: the customer copy for the special requirements and exact scope
 * denials is only truthful while it matches what the server resolvers check.
 * This test reads the latest definitions and fails when a resolver gains,
 * drops or moves a condition, so the copy is re-verified instead of drifting.
 * OVD-993 extends it to the remaining envelope denials: Process, Material,
 * Finish, the admitted process list, the drawing check and the service kinds.
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

// OVD-993: the remaining envelope denials. Each block pins the condition the
// resolver checks, so the copy's named field, accepted value or explanation is
// re-verified when the SQL changes.

const LEGACY_RESOLVER = "create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(";
const GENERIC_RESOLVER = "create or replace function private.resolve_provider_dispatch_scope(";

/** The resolvers' normalization: trimmed, lowercased, every character outside a-z and 0-9 dropped. */
function sqlNormalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The quoted values of `if <variable> not in (...) then raise exception '<code>'`. */
function acceptedValues(body: string, variable: string, code: string): string[] {
  const match = new RegExp(`if ${variable} not in \\(([^)]*)\\) then raise exception '${code}'`).exec(body);
  expect(match, `${variable} check raising ${code}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']*)'/g)].map((found) => found[1]);
}

describe("OVD-993 legacy Xometry envelope fields", () => {
  const { body } = latestDefinition(LEGACY_RESOLVER);

  it("normalizes Process, Material and Finish the way the copy's values assume", () => {
    expect(body).toContain(
      "v_process := pg_catalog.regexp_replace( pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))), '[^a-z0-9]', '', 'g'",
    );
    expect(body).toContain(
      "v_material := pg_catalog.regexp_replace( pg_catalog.lower(pg_catalog.btrim(v_requirement.material)), '[^a-z0-9]', '', 'g'",
    );
    expect(body).toContain(
      "v_finish := pg_catalog.regexp_replace( pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.finish, ''))), '[^a-z0-9]', '', 'g'",
    );
  });

  it.each([
    ["v_process", "xometry_beta_cnc_milling_required", ["cncmilling", "cncmachining", "milling"], "set Process to CNC milling", ["CNC milling"]],
    ["v_material", "xometry_beta_6061_t6_required", ["6061t6", "6061t6aluminum", "aluminum6061t6"], "set Material to 6061-T6 aluminum", ["6061-T6 aluminum"]],
    // A blank Finish is accepted, which is what "leave it blank" names.
    ["v_finish", "xometry_beta_as_machined_required", ["", "asmachined"], "set Finish to As machined or leave it blank", ["As machined", ""]],
  ] as const)("%s: the copy for %s names only values the resolver accepts", (variable, code, accepted, instruction, namedValues) => {
    // A changed accepted set must re-verify the copy.
    expect(acceptedValues(body, variable, code)).toEqual([...accepted]);
    const message = getXometryBetaScopeFailureMessage({ message: code }, "fictiv");
    expect(message).toContain(instruction);
    for (const value of namedValues) {
      expect(accepted, value).toContain(sqlNormalize(value));
    }
  });
});

describe.each([
  { label: "legacy Xometry resolver", signature: LEGACY_RESOLVER, code: "xometry_beta_manufacturing_quote_only" },
  { label: "generic provider resolver", signature: GENERIC_RESOLVER, code: "provider_dispatch_manufacturing_quote_only" },
])("$label manufacturing quote only", ({ signature, code }) => {
  const { body } = latestDefinition(signature);
  const message = getXometryBetaScopeFailureMessage({ message: code }, "fictiv");

  it("refuses any normalized service set other than exactly manufacturing_quote, as the copy says", () => {
    expect(body).toContain(
      `if public.normalize_requested_service_kinds( v_job.requested_service_kinds, v_job.primary_service_kind ) is distinct from array['manufacturing_quote']::text[] then raise exception '${code}'`,
    );
    expect(message).toContain("a service other than Manufacturing quote");
    expect(message).toContain("quotes manufacturing only");
  });

  it("names every other service kind the normalizer keeps, in the form's words", () => {
    const normalizer = latestDefinition("create or replace function public.normalize_requested_service_kinds(").body;
    const kindList = /v_valid_kinds constant text\[\] := array\[([^\]]*)\]/.exec(normalizer)?.[1] ?? "";
    const kinds = [...kindList.matchAll(/'([a-z_]+)'/g)].map((found) => found[1]);
    expect(kinds).toContain("manufacturing_quote");
    // The form offers exactly the kinds the server keeps, so the copy can name them from the form.
    expect([...kinds].sort()).toEqual(REQUESTED_SERVICE_TYPE_OPTIONS.map((option) => option.code).sort());
    for (const kind of kinds.filter((candidate) => candidate !== "manufacturing_quote")) {
      const option = REQUESTED_SERVICE_TYPE_OPTIONS.find((candidate) => candidate.code === kind);
      expect(option, kind).toBeDefined();
      expect(message, kind).toContain(option!.label);
    }
  });

  it("promises no action, since the dialog cannot change the job's services", () => {
    expect(message).not.toMatch(/\b(?:retry|set|remove|clear|change|then)\b/i);
  });
});

describe("provider_dispatch_process_not_admitted", () => {
  const { body } = latestDefinition(GENERIC_RESOLVER);
  const message = getXometryBetaScopeFailureMessage({ message: "provider_dispatch_process_not_admitted" }, "fictiv");

  it("refuses a blank Process or one outside the provider's admitted processes, as the copy says", () => {
    expect(body).toContain(
      "v_process := pg_catalog.regexp_replace( pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))), '[^a-z0-9]', '', 'g' );",
    );
    expect(body).toContain(
      "if v_process = '' or not exists ( select 1 from pg_catalog.unnest(v_admission.supported_processes) supported(process) where pg_catalog.regexp_replace(supported.process::text, '[^a-z0-9]', '', 'g') = v_process ) then raise exception 'provider_dispatch_process_not_admitted'",
    );
    expect(message).toContain("Process is blank or not one of them");
    expect(message).toContain("Set Process to the process that makes this part, then retry");
  });

  it("names no process, material or finish: the admitted list is server-side and the generic path checks neither material nor finish", () => {
    expect(body).toContain("v_admission.supported_processes");
    expect(body).not.toContain("v_material");
    expect(body).not.toContain("v_finish");
    expect(message).not.toMatch(/CNC|mill/i);
    expect(message).not.toContain("Material");
    expect(message).not.toContain("Finish");
  });
});

describe("xometry_beta_compatible_drawing_required", () => {
  const { body } = latestDefinition(LEGACY_RESOLVER);
  const message = getXometryBetaScopeFailureMessage({ message: "xometry_beta_compatible_drawing_required" }, "fictiv");

  it("is raised only for an attached drawing that is not a verified PDF of this job, as the copy says", () => {
    const start = body.indexOf("if v_part.drawing_file_id is not null then");
    const end = body.indexOf("raise exception 'xometry_beta_compatible_drawing_required'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = body.slice(start, end);
    for (const condition of [
      "v_drawing.id is null",
      "v_drawing.job_id <> v_job.id",
      "v_drawing.organization_id <> v_job.organization_id",
      "v_drawing.file_kind <> 'drawing'",
      "lower(v_drawing.original_name) !~ '\\.pdf$'",
      "v_drawing.trusted_content_sha256 is null",
      "v_drawing.trusted_content_sha256 !~ '^[a-f0-9]{64}$'",
    ]) {
      expect(block, condition).toContain(condition);
    }
    expect(body.match(/raise exception 'xometry_beta_compatible_drawing_required'/g)).toHaveLength(1);
    expect(message).toContain("a drawing only as a PDF whose uploaded bytes have been verified");
  });

  it("can only be waited out: the worker alone registers the verified hash, so the copy asks for a retry, not a removal", () => {
    const register = latestDefinition("create or replace function public.api_register_trusted_file_hash(").body;
    expect(register).toContain("if auth.role() <> 'service_role' then raise exception");
    expect(register).toContain("set trusted_content_sha256 = v_hash");
    expect(message).toContain("Wait for file processing to finish, then retry the scope check");
    expect(message).toContain("if it still fails, contact support");
    expect(message).not.toMatch(/\bremove\b/i);
    expect(message).not.toMatch(/register/i);
  });
});
