// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClientPartRequestUpdateInput } from "./types";
import { REQUESTED_SERVICE_TYPE_OPTIONS } from "./service-intent";
import { BETA_6061_T6_MATERIAL, SERVER_SPECIAL_REQUIREMENT_PATHS, getXometryBetaScopeFailureMessage } from "./xometry-beta-dispatch";

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

function latestDefinition(
  signature: string,
  sources = sqlFiles.map((file) => ({ file, sql: readFileSync(`${MIGRATIONS}/${file}`, "utf8") })),
): { file: string; body: string } {
  const [, schema, name] = signature.match(/\b(private|public)\.(\w+)/i)!;
  const declaration = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${schema}\\s*\\.\\s*${name}\\b`, "gi");
  const definition = new RegExp(`${declaration.source}\\s*\\([\\s\\S]*?\\bas\\s+(\\$(?:[a-z_][a-z_0-9]*)?\\$)([\\s\\S]*?)\\1`, "gi");
  let latest: { file: string; body: string } | undefined;
  for (const { file, sql } of sources) {
    const declarations = [...sql.matchAll(declaration)];
    const definitions = [...sql.matchAll(definition)];
    if (declarations.length !== definitions.length) {
      throw new Error(`Unmatched definition of ${name} in ${file}`);
    }
    const match = definitions.at(-1);
    if (match) latest = { file, body: normalize(match[0].replace(/--[^\n]*/g, "")) };
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
  const message = getXometryBetaScopeFailureMessage({ message: code }, "fictiv", { request: allSetRequest, requestComplete: true });

  it("denies exactly the special requirements the copy names", () => {
    for (const [sqlFragment, copyFragment] of DENIED_SPECIAL_REQUIREMENTS) {
      expect(block, sqlFragment).toContain(sqlFragment);
      expect(message, copyFragment).toContain(copyFragment);
    }
    // A new condition must be added to the table above and to the copy.
    expect(block.match(/v_special\s*(?:->>|#>>|#>)\s*/gi)).toHaveLength(DENIED_SPECIAL_REQUIREMENTS.length);
  });

  it("pins every client completeness path to the server reads", () => {
    const paths = [...block.matchAll(/v_special\s*(?:->>|#>>|#>)\s*'([^']+)'/gi)]
      .map((match) => match[1].replace(/[{}]/g, "").replace(/,/g, "."));
    expect([...SERVER_SPECIAL_REQUIREMENT_PATHS].sort()).toEqual(paths.sort());
  });

  it("uses the full list when packaging notes are absent from the client payload", () => {
    const request = { ...allSetRequest, notes: "Deburr", shipping: { shippingNotes: null } };
    const copy = getXometryBetaScopeFailureMessage({ message: code }, "fictiv", {
      requestComplete: true,
      request: request as Partial<ClientPartRequestUpdateInput>,
    });
    expect(copy).toContain("Notes (including service, packaging, shipping, certification, sourcing and release notes)");
    expect(copy).toContain("Threads");
    expect(copy).toContain("required certifications");
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
    expect(message).toContain("supplier applies to this part");
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

// OVD-998: read the newest resolver, so a later quantity condition change requires copy review.
describe("quantity denial copy matches the latest resolver", () => {
  it("pins the grant quantity-and-scope gate when the switch is disabled", () => {
    const { body } = latestDefinition("create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(");
    const start = body.indexOf("if v_candidate.requested_quantity <> 1");
    const end = body.indexOf("return pg_catalog.jsonb_build_object(", start);
    expect(body.slice(start, end)).toBe(
      "if v_candidate.requested_quantity <> 1 and not private.xometry_beta_user_quantity_enabled() and private.xometry_beta_quantity_grant_id( p_job_id, p_existing_permit_id, v_candidate.scope_fingerprint, v_candidate.requested_quantity ) is null then raise exception 'xometry_beta_quantity_one_required'; end if; ",
    );
  });

  it("has exactly two quantity-one denial sites in the latest resolver", () => {
    const { body } = latestDefinition("create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(");
    expect(body.match(/raise exception 'xometry_beta_quantity_one_required'/g)).toHaveLength(2);
  });

  it("keeps quantity 1 only behind the disabled switch or a per-request grant, and otherwise requires one positive quantity", () => {
    const { body: sql } = latestDefinition("create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(");
    const start = sql.lastIndexOf("if public.normalize_positive_integer_array(");
    const end = sql.indexOf("if v_requirement.applicable_vendors", start);
    expect(sql.slice(start, end)).toBe(
      "if public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity ) is distinct from array[1]::integer[] and not private.xometry_beta_user_quantity_enabled() and private.xometry_beta_quantity_grant_id(p_job_id, p_existing_permit_id, null, null) is null then raise exception 'xometry_beta_quantity_one_required'; end if; if pg_catalog.cardinality(public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity )) <> 1 then raise exception 'xometry_beta_single_quantity_required'; end if; ",
    );
    expect(getXometryBetaScopeFailureMessage({ message: "xometry_beta_quantity_one_required" })).toContain("quantity 1 only");
    expect(getXometryBetaScopeFailureMessage({ message: "xometry_beta_single_quantity_required" })).toContain("exactly one quantity of 1 or more");
  });
});

it("keeps the worker quantity note bound to the latest server switch-or-grant refusal", () => {
  const { body } = latestDefinition("create or replace function public.api_authorize_xometry_beta_worker_dispatch(");
  const start = body.indexOf("if v_lane.requested_quantity <> 1 then");
  const end = body.indexOf("end if; end if;", start) + "end if; end if;".length;
  expect(body.slice(start, end)).toBe(
    "if v_lane.requested_quantity <> 1 then perform pg_catalog.pg_advisory_xact_lock_shared( pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0) ); perform pg_catalog.pg_advisory_xact_lock_shared( pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || v_permit.job_id::text, 0) ); if not private.xometry_beta_user_quantity_enabled() and private.xometry_beta_quantity_grant_id( v_permit.job_id, v_permit.id, v_permit.scope_fingerprint, v_lane.requested_quantity ) is null then return pg_catalog.jsonb_build_object( v_authorized_key, false, v_reason_key, 'dispatch_quantity_not_admitted' ); end if; end if;",
  );
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

  it("v_process: the copy for xometry_beta_cnc_milling_required names only values the resolver accepts", () => {
    const accepted = ["cncmilling", "cncmachining", "milling"];
    // A changed accepted set must re-verify the copy.
    expect(acceptedValues(body, "v_process", "xometry_beta_cnc_milling_required")).toEqual(accepted);
    const message = getXometryBetaScopeFailureMessage({ message: "xometry_beta_cnc_milling_required" }, "fictiv");
    expect(message).toContain("set Process to CNC milling");
    expect(accepted).toContain(sqlNormalize("CNC milling"));
  });

  // OVD-1163: 6061 without a temper is the beta's 6061-T6; another stated temper stays refused.
  describe("v_material", () => {
    const match = /if v_material !~ '([^']+)' then raise exception 'xometry_beta_6061_t6_required'/.exec(body);
    const pattern = new RegExp(match?.[1] ?? "(?!)");

    it("is the one anchored 6061-T6 pattern the copy and the fix rely on", () => {
      expect(match?.[1]).toBe(
        "^(aluminum|aluminium|al)?(alloy)?6061(t6|t651|t6511|t6t651)?(aluminum|aluminium|al)?(alloy)?$",
      );
      expect(body.match(/raise exception 'xometry_beta_6061_t6_required'/g)).toHaveLength(1);
    });

    it.each([
      "6061", "6061 Alloy", "Al 6061", "6061 aluminum", "Aluminum 6061", "ALUMINIUM 6061", "6061-T6",
      "6061-T6 aluminum", "Aluminum 6061-T6", "6061-T651", "Aluminum 6061-T6511", "6061-T6/T651",
    ])("accepts %s", (material) => {
      expect(pattern.test(sqlNormalize(material))).toBe(true);
    });

    it.each(["6061-O", "6061-T4", "6061-T451", "6061-F", "6061-T62", "7075-T6", "Aluminum", "16061", "6061 steel"])(
      "refuses %s",
      (material) => {
        expect(pattern.test(sqlNormalize(material))).toBe(false);
      },
    );

    it("saves, through the one-click fix, a material the resolver accepts", () => {
      expect(pattern.test(sqlNormalize(BETA_6061_T6_MATERIAL))).toBe(true);
      const message = getXometryBetaScopeFailureMessage({ message: "xometry_beta_6061_t6_required" }, "fictiv");
      expect(message).toContain("6061-T6 aluminum");
      expect(pattern.test(sqlNormalize("6061-T6 aluminum"))).toBe(true);
    });
  });

  // OVD-1163: a drawing finish passes only with the customer's quote-only as-machined choice for it.
  it("v_finish: blank, As machined, or a quoteAsMachined choice naming this exact finish", () => {
    const start = body.indexOf("if v_finish not in ('', 'asmachined')");
    const end = body.indexOf("raise exception 'xometry_beta_as_machined_required'");
    expect(start).toBeGreaterThan(-1);
    expect(body.slice(start, end)).toBe(
      "if v_finish not in ('', 'asmachined') and v_finish is distinct from pg_catalog.regexp_replace( pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot #>> '{quoteAsMachined,finish}', ''))), '[^a-z0-9]', '', 'g' ) then ",
    );
    expect(body.match(/raise exception 'xometry_beta_as_machined_required'/g)).toHaveLength(1);
    // The resolver never rewrites the finish it checks.
    expect(body).not.toMatch(/update public\.approved_part_requirements/);
    const message = getXometryBetaScopeFailureMessage({ message: "xometry_beta_as_machined_required" }, "fictiv");
    expect(message).toContain("Finishes can't be quoted yet");
    expect(message).toContain("as machined");
  });

  it("the quote-as-machined RPC writes only spec_snapshot.quoteAsMachined, never the finish column", () => {
    const rpc = latestDefinition("create or replace function public.api_set_client_part_quote_as_machined(").body;
    expect(rpc).toContain("from public.load_editable_project_part_context(p_job_id)");
    expect(rpc.match(/update public\.\w+/g)).toEqual(["update public.approved_part_requirements"]);
    const update = rpc.slice(rpc.indexOf("update public.approved_part_requirements"), rpc.indexOf("get diagnostics"));
    expect(update).toMatch(/^update public\.approved_part_requirements set spec_snapshot = case/);
    expect(update).not.toMatch(/\bfinish\s*=/);
    expect(rpc).toContain("pg_catalog.jsonb_build_object('finish', v_finish)");
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
    expect(message).toContain("only manufacturing can be quoted here");
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
    expect(message).toContain("Process is blank or can't be quoted by this supplier");
    expect(message).toContain("Set Process to the process that makes this part, then check again");
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
    expect(message).toContain("The drawing must be a PDF whose uploaded bytes have been verified");
  });

  it("can only be waited out: the worker alone registers the verified hash, so the copy asks for a retry, not a removal", () => {
    const register = latestDefinition("create or replace function public.api_register_trusted_file_hash(").body;
    expect(register).toContain("if auth.role() <> 'service_role' then raise exception");
    expect(register).toContain("set trusted_content_sha256 = v_hash");
    expect(message).toContain("Wait for file processing to finish, then check again");
    expect(message).toContain("If it still fails, contact support");
    expect(message).not.toMatch(/\bremove\b/i);
    expect(message).not.toMatch(/register/i);
  });
});
