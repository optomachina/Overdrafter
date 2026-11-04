// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRequirementDraft, normalizeClientPartMetadata } from "./utils";
import type { PartAggregate } from "./types";

const filename = "20261104031900_ovd1151_client_part_request_metadata.sql";
const migration = readFileSync(`supabase/migrations/${filename}`, "utf8");
const previous = readFileSync("supabase/migrations/20261031052436_ovd746_client_rpc_auth_gate.sql", "utf8");
const rollback = readFileSync("docs/migration-drafts/ovd-1151.rollback.sql", "utf8");
const wrapperBody = (sql: string) => {
  const start = sql.indexOf("as $$", sql.indexOf("create or replace function public.api_list_client_part_metadata("));
  return sql.slice(start + "as $$".length, sql.indexOf("$$;", start));
};
const md5 = (sql: string) => createHash("md5").update(wrapperBody(sql)).digest("hex");

// Every key api_update_client_part_request writes into these four objects
// (20261101130200_ovd994_clear_need_by_and_threads.sql), by object.
const SAVED_KEYS = {
  shipping: ["packagingNotes", "shippingNotes"],
  certifications: [
    "requiredCertifications",
    "materialCertificationRequired",
    "certificateOfConformanceRequired",
    "inspectionLevel",
    "notes",
  ],
  sourcing: ["regionPreferenceOverride", "preferredSuppliers", "materialProvisioning", "notes"],
  release: ["releaseStatus", "notes"],
} as const;

describe("OVD-1151 client part request metadata migration", () => {
  it("restates only the public wrapper with an md5 guard in both directions", () => {
    expect(migration).toContain("create or replace function public.api_list_client_part_metadata(p_job_ids uuid[])");
    expect(migration).not.toContain("function private.");
    expect(md5(previous)).toBe("9127a3995b7bb5fc089ea4fa91525652");
    expect(migration).toContain(`not in ('${md5(previous)}', '${md5(migration)}')`);
    expect(rollback).toContain(`not in ('${md5(migration)}', '${md5(previous)}')`);
    expect(wrapperBody(rollback)).toBe(wrapperBody(previous));
    const newer = readdirSync("supabase/migrations").filter((name) => name > filename);
    expect(newer.filter((name) => /create or replace function (?:public|private)\.api_list_client_part_metadata/.test(
      readFileSync(`supabase/migrations/${name}`, "utf8"),
    ))).toEqual([]);
  });

  it("keeps the verified-auth gate, security attributes and ACL", () => {
    for (const sql of [migration, rollback]) {
      expect(sql).toContain("language plpgsql\nstable\nsecurity definer\nset search_path = ''\nas $$\nbegin\n  perform public.require_verified_auth();");
      expect(sql).toContain("revoke all on function public.api_list_client_part_metadata(uuid[]) from public, anon;");
      expect(sql).toContain("grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated, service_role;");
      expect(sql.indexOf("set local lock_timeout = '5s';")).toBeLessThan(sql.indexOf("do $ovd1151_guard$"));
      expect(sql.indexOf("$ovd1151_guard$;")).toBeLessThan(sql.indexOf("create or replace function"));
      expect(sql).toContain("using errcode = '55000'");
    }
  });

  it("projects exactly the keys the full save writes and no internal-only key", () => {
    const body = wrapperBody(migration);
    const projected = [...body.matchAll(/'(\w+)', requirement\.spec_snapshot #> '\{(\w+),(\w+)\}'/g)];
    expect(projected.every(([, key, , path]) => key === path)).toBe(true);
    expect(Object.fromEntries(Object.keys(SAVED_KEYS).map((group) => [
      group,
      projected.filter(([, , objectName]) => objectName === group).map(([, key]) => key),
    ]))).toEqual(SAVED_KEYS);
    for (const internalKey of ["reviewDisposition", "quoteBlockedUntilRelease", "requestedByDateOverride"]) {
      expect(body).not.toContain(internalKey);
    }
  });

  it("feeds the projected details into the client request draft", () => {
    const requestMetadata = {
      shipping: { packagingNotes: "Bag and tag each part", shippingNotes: null },
      certifications: { requiredCertifications: ["AS9100"], inspectionLevel: "fai" },
      sourcing: { preferredSuppliers: ["Acme Machining"], materialProvisioning: "customer_supplied" },
      release: { releaseStatus: "prototype", reviewDisposition: "hold", quoteBlockedUntilRelease: true, notes: null },
    };
    const metadata = normalizeClientPartMetadata({ partId: "part-1", jobId: "job-1", organizationId: "org-1", requestMetadata });
    expect(metadata?.requirement.requestMetadata).toMatchObject({
      shipping: { packagingNotes: "Bag and tag each part", shippingNotes: null },
      certifications: { requiredCertifications: ["AS9100"], inspectionLevel: "fai" },
      sourcing: { preferredSuppliers: ["Acme Machining"], materialProvisioning: "customer_supplied" },
      // Never trust internal-only review state from the wire.
      release: { releaseStatus: "prototype", reviewDisposition: null, quoteBlockedUntilRelease: null },
    });
    expect(normalizeClientPartMetadata({ partId: "part-1", jobId: "job-1", organizationId: "org-1" })?.requirement.requestMetadata)
      .toBeNull();

    const draft = buildRequirementDraft({
      id: "part-1",
      quantity: 1,
      extraction: null,
      approvedRequirement: null,
      clientRequirement: metadata?.requirement ?? null,
    } as unknown as PartAggregate);
    expect(draft.shipping.packagingNotes).toBe("Bag and tag each part");
    expect(draft.certifications.requiredCertifications).toEqual(["AS9100"]);
    expect(draft.sourcing.materialProvisioning).toBe("customer_supplied");
    expect(draft.release.releaseStatus).toBe("prototype");
  });
});
