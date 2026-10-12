// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  detectExportControlMarkings,
  enforceExportControlMarkings,
  evaluateExportControlDispatch,
  EXPORT_CONTROL_DENIAL_CODES,
  ExportControlMarkingBlockedError,
  ExportControlMarkingRecordError,
  exportControlProviderJurisdiction,
  FOREIGN_JURISDICTION_PROVIDERS,
  isStepFileName,
  readStepHeaderText,
  scanDrawingTextForExportMarkings,
  scanStepHeaderForExportMarkings,
} from "./exportControl";
import { PROVIDER_DISPATCH_DENIAL_CODES, isRetryableProviderDispatchDenial } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError, quoteWithProviderDispatchPreflight } from "./providerDispatchPreflight";
import { quoteWithDispatchPreflight, XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";
import type { VendorName, VendorQuoteAdapterInput } from "./types";

const draft = readFileSync(new URL("../../docs/migration-drafts/ovd-723.sql", import.meta.url), "utf8");

/** Title-block and note text as pdftotext/tesseract return it. */
const MARKING_FIXTURES = {
  itarStamp: "WARNING - THIS DOCUMENT CONTAINS TECHNICAL DATA WHOSE EXPORT IS RESTRICTED BY THE ITAR",
  eccn: "EXPORT CLASSIFICATION: ECCN 9E991",
  eccnShape: "CLASSIFIED 3A001 PER SUPPLEMENT 1",
  cui: "CUI // SP-EXPT",
  distributionStatement: "DISTRIBUTION STATEMENT D. Distribution authorized to the DoD and U.S. DoD contractors only.",
  usmlCategory: "USML Category XI(c)",
  cfr22: "Subject to 22 CFR 120-130",
  cfr15: "Controlled under 15 C.F.R. 734",
  earExport: "This item is subject to the EAR and may require an export license.",
  exportControlled: "EXPORT-CONTROLLED: do not disseminate",
} as const;

const CLEAN_DRAWING = [
  "BRACKET, MOUNTING  REV A  SHEET 1 OF 1",
  "MATERIAL: 6061-T6 ALUMINUM  FINISH: ANODIZE TYPE II CLEAR",
  "UNLESS OTHERWISE SPECIFIED DIMENSIONS ARE IN INCHES. TOLERANCES .XX +/-.01",
  "LINEAR GEAR RACK, BREAK ALL EDGES, DEBURR",
].join("\n");

const STEP_WITH_ITAR = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION(('ITAR CONTROLLED - USML CATEGORY IV'),'2;1');",
  "FILE_NAME('bracket.step','2026-10-01T00:00:00',('A. Engineer'),('Acme'),'SW','SolidWorks','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
  "ENDSEC;",
  "DATA;",
  "#1=PRODUCT('bracket','bracket','',(#2));",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\n");

const STEP_CLEAN_HEADER_MARKED_DATA = STEP_WITH_ITAR.replace(
  "FILE_DESCRIPTION(('ITAR CONTROLLED - USML CATEGORY IV'),'2;1');",
  "FILE_DESCRIPTION(('bracket'),'2;1');",
).replace("#1=PRODUCT('bracket'", "#1=PRODUCT('ITAR note in geometry data'");

describe("export-control marking detection", () => {
  it.each(Object.entries(MARKING_FIXTURES))("flags the %s fixture", (_name, text) => {
    expect(detectExportControlMarkings(text).length).toBeGreaterThan(0);
  });

  it("matches case-insensitively", () => {
    expect(detectExportControlMarkings("itar controlled")).toContain("itar");
    expect(detectExportControlMarkings("Distribution Statement c")).toContain("distribution_statement");
    expect(detectExportControlMarkings("cui")).toContain("cui");
  });

  it("names every matching pattern", () => {
    expect(detectExportControlMarkings(MARKING_FIXTURES.itarStamp)).toEqual(["itar", "technical_data"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.eccn)).toEqual(["eccn", "eccn_shape"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.eccnShape)).toEqual(["eccn_shape"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.cfr22)).toEqual(["cfr_22_itar"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.cfr15)).toEqual(["cfr_15_ear"]);
  });

  it("does not flag an ordinary drawing or EAR inside other words", () => {
    expect(detectExportControlMarkings(CLEAN_DRAWING)).toEqual([]);
    expect(detectExportControlMarkings("NEAR SIDE, YEAR 2026, GEAR")).toEqual([]);
    expect(detectExportControlMarkings(null)).toEqual([]);
    expect(detectExportControlMarkings("")).toEqual([]);
  });

  it("scans every drawing page", () => {
    const scan = scanDrawingTextForExportMarkings({
      pages: [{ text: CLEAN_DRAWING }, { text: MARKING_FIXTURES.cui }],
    });
    expect(scan).toEqual({ source: "drawing_text", patterns: ["cui"] });
    expect(scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.cui }] }, { ocr: true })?.source).toBe(
      "drawing_ocr",
    );
    expect(scanDrawingTextForExportMarkings({ pages: [{ text: CLEAN_DRAWING }] })).toBeNull();
    expect(scanDrawingTextForExportMarkings(null)).toBeNull();
  });

  it("reads only the STEP header section and scans it", () => {
    expect(readStepHeaderText(STEP_WITH_ITAR)).toContain("FILE_DESCRIPTION");
    expect(readStepHeaderText(STEP_WITH_ITAR)).not.toContain("#1=PRODUCT");
    expect(scanStepHeaderForExportMarkings(new TextEncoder().encode(STEP_WITH_ITAR))).toEqual({
      source: "step_header",
      patterns: ["itar", "usml", "usml_category"],
    });
    expect(scanStepHeaderForExportMarkings(STEP_CLEAN_HEADER_MARKED_DATA)).toBeNull();
  });

  it("scans the whole prefix when the STEP header is malformed", () => {
    expect(scanStepHeaderForExportMarkings("no header here; ITAR")).toEqual({ source: "step_header", patterns: ["itar"] });
  });

  it("recognizes STEP file names", () => {
    expect(isStepFileName("bracket.STEP")).toBe(true);
    expect(isStepFileName("bracket.stp")).toBe(true);
    expect(isStepFileName("bracket.sldprt")).toBe(false);
    expect(isStepFileName(null)).toBe(false);
  });
});

describe("marking enforcement (records a block, then stops the task)", () => {
  const input = { jobId: "job-1", partId: "part-1", jobFileId: "file-1" };

  it("records a blocked_pending_review block and throws on a hit", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "block-1", error: null });
    const scan = scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.itarStamp }] });

    await expect(enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan })).rejects.toBeInstanceOf(
      ExportControlMarkingBlockedError,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_marking_hits", {
      p_job_id: "job-1",
      p_part_id: "part-1",
      p_job_file_id: "file-1",
      p_source: "drawing_text",
      p_patterns: ["itar", "technical_data"],
    });
  });

  it("fails closed when the block cannot be recorded", async () => {
    const scan = scanStepHeaderForExportMarkings(STEP_WITH_ITAR);
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: null, error: null }),
    ]) {
      await expect(
        enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan }),
      ).rejects.toBeInstanceOf(ExportControlMarkingRecordError);
    }
  });

  it("does nothing when nothing matched", async () => {
    const rpc = vi.fn();
    await expect(
      enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan: null }),
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("export-control dispatch rule (reference model of the SQL gate)", () => {
  const clean = { latestAnswer: "not_controlled" as const, markingBlocked: false };

  it.each<VendorName>(["xometry", "fictiv", "quickparts"])("admits %s only with a clean, unblocked declaration", (provider) => {
    expect(evaluateExportControlDispatch({ provider, ...clean })).toBeNull();
    expect(evaluateExportControlDispatch({ provider, latestAnswer: null, markingBlocked: false })).toBe(
      "export_declaration_missing",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "missing", markingBlocked: false })).toBe(
      "export_declaration_missing",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "controlled", markingBlocked: false })).toBe(
      "export_declaration_not_clean",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "unsure", markingBlocked: false })).toBe(
      "export_declaration_not_clean",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "not_controlled", markingBlocked: true })).toBe(
      "export_review_pending",
    );
  });

  it.each<VendorName>(["weerg", "geomiq"])("denies foreign provider %s with its own code unless clean", (provider) => {
    expect(exportControlProviderJurisdiction(provider)).toBe("foreign");
    expect(evaluateExportControlDispatch({ provider, ...clean })).toBeNull();
    for (const latestAnswer of [null, "missing", "controlled", "unsure"] as const) {
      expect(evaluateExportControlDispatch({ provider, latestAnswer, markingBlocked: false })).toBe(
        "export_foreign_provider_requires_clean_declaration",
      );
    }
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "not_controlled", markingBlocked: true })).toBe(
      "export_foreign_provider_requires_clean_declaration",
    );
  });

  it("treats an unknown provider like a foreign one", () => {
    expect(exportControlProviderJurisdiction("brand-new-provider")).toBe("unknown");
    expect(evaluateExportControlDispatch({ provider: "brand-new-provider", latestAnswer: null, markingBlocked: false })).toBe(
      "export_foreign_provider_requires_clean_declaration",
    );
  });

  it("denies when the lookup failed or the evidence is malformed", () => {
    expect(evaluateExportControlDispatch({ lookupFailed: true })).toBe("export_control_lookup_failed");
    expect(evaluateExportControlDispatch({} as never)).toBe("export_control_lookup_failed");
    expect(
      evaluateExportControlDispatch({ provider: "fictiv", latestAnswer: "not_controlled" } as never),
    ).toBe("export_review_pending");
  });
});

describe("worker preflights surface the export-control denials", () => {
  it("adds every export code to the closed, terminal provider vocabulary", () => {
    for (const code of EXPORT_CONTROL_DENIAL_CODES) {
      expect(PROVIDER_DISPATCH_DENIAL_CODES).toContain(code);
      expect(isRetryableProviderDispatchDenial(code)).toBe(false);
    }
  });

  it.each<[VendorName, (typeof EXPORT_CONTROL_DENIAL_CODES)[number]]>([
    ["fictiv", "export_declaration_missing"],
    ["fictiv", "export_declaration_not_clean"],
    ["fictiv", "export_review_pending"],
    ["fictiv", "export_control_lookup_failed"],
    ["weerg", "export_foreign_provider_requires_clean_declaration"],
    ["geomiq", "export_foreign_provider_requires_clean_declaration"],
  ])("generic preflight for %s: %s makes zero adapter calls", async (provider, denial) => {
    const rpc = vi.fn().mockResolvedValue({
      data: { schema: "provider-dispatch-authorization.v1", authorized: false, denial, retryable: false },
      error: null,
    });
    const quote = vi.fn();
    const run = quoteWithProviderDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      workerName: "worker-1",
      claimedAt: "2026-10-11T12:00:00.000Z",
      claim: {
        workQueueTaskId: "00000000-0000-4000-8000-000000007231",
        vendorQuoteResultId: "00000000-0000-4000-8000-000000007232",
        provider,
        permitId: "00000000-0000-4000-8000-000000007233",
        envelopeFingerprint: "a".repeat(64),
      },
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: provider },
      adapter: { quote },
      quoteInput: {} as VendorQuoteAdapterInput,
    });
    await expect(run).rejects.toEqual(new ProviderDispatchAuthorizationError(denial));
    await expect(run).rejects.toMatchObject({ retryable: false });
    expect(quote).not.toHaveBeenCalled();
  });

  it.each(EXPORT_CONTROL_DENIAL_CODES)("Xometry preflight: %s is kept and makes zero adapter calls", async (reasonCode) => {
    const rpc = vi.fn().mockResolvedValue({ data: { authorized: false, reasonCode }, error: null });
    const quote = vi.fn();
    await expect(
      quoteWithDispatchPreflight({
        supabase: { rpc } as unknown as SupabaseClient,
        config: { workerMode: "live", workerName: "worker-1" },
        workQueueTaskId: "task-1",
        vendorQuoteResultId: "result-1",
        claimedAt: "2026-10-11T12:00:00.000Z",
        vendor: "xometry",
        scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "xometry" },
        adapter: { quote },
        quoteInput: {} as VendorQuoteAdapterInput,
      }),
    ).rejects.toEqual(new XometryDispatchAuthorizationError(reasonCode));
    expect(quote).not.toHaveBeenCalled();
  });

  it("denies when the preflight lookup itself errors (fail closed)", async () => {
    const quote = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "lookup failed" } });
    await expect(
      quoteWithDispatchPreflight({
        supabase: { rpc } as unknown as SupabaseClient,
        config: { workerMode: "live", workerName: "worker-1" },
        workQueueTaskId: "task-1",
        vendorQuoteResultId: "result-1",
        claimedAt: "2026-10-11T12:00:00.000Z",
        vendor: "xometry",
        scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "xometry" },
        adapter: { quote },
        quoteInput: {} as VendorQuoteAdapterInput,
      }),
    ).rejects.toBeInstanceOf(XometryDispatchAuthorizationError);
    expect(quote).not.toHaveBeenCalled();
  });
});

describe("OVD-723 migration draft", () => {
  it("is a draft, not an applied migration", () => {
    expect(draft.startsWith("-- =")).toBe(true);
    expect(draft).toContain("NEEDS BLAINE MIGRATION WINDOW - not applied");
    expect(draft).toMatch(/PHASE 1 - EXPAND[\s\S]*PHASE 2 - CONTRACT[\s\S]*ROLLBACK/);
    const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of readdirSync(migrationsDir)) {
      expect(readFileSync(new URL(name, migrationsDir), "utf8")).not.toContain("job_export_declarations");
    }
  });

  it("returns every worker export code and nothing else from the gate", () => {
    const gate = draft.slice(draft.indexOf("function private.export_control_dispatch_denial("));
    for (const code of EXPORT_CONTROL_DENIAL_CODES) expect(draft).toContain(`'${code}'`);
    const returned = [...gate.slice(0, gate.indexOf("$$;")).matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(returned)).toEqual(new Set(EXPORT_CONTROL_DENIAL_CODES));
  });

  it("checks foreign providers first, as a separate rule, and fails closed on lookup errors", () => {
    const gate = draft.slice(draft.indexOf("function private.export_control_dispatch_denial("));
    const body = gate.slice(0, gate.indexOf("$$;"));
    expect(body.indexOf("export_foreign_provider_requires_clean_declaration")).toBeLessThan(
      body.indexOf("'export_declaration_missing'", body.indexOf("export_foreign_provider_requires_clean_declaration")),
    );
    expect(body).toContain("is distinct from 'us'");
    expect(body).toMatch(/exception when others then\s+return 'export_control_lookup_failed'/);
  });

  it("keeps the SQL jurisdiction list in step with the worker", () => {
    const fn = draft.slice(draft.indexOf("function private.export_control_provider_jurisdiction"));
    const foreign = /when p_provider in \(([^)]*)\) then 'foreign'/.exec(fn)?.[1] ?? "";
    expect(new Set([...foreign.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))).toEqual(new Set(FOREIGN_JURISDICTION_PROVIDERS));
    const us = /when p_provider in \(([\s\S]*?)\) then 'us'/.exec(fn.slice(fn.indexOf("then 'foreign'")))?.[1] ?? "";
    expect(us).toContain("'xometry'");
    for (const provider of [...us.matchAll(/'([a-z]+)'/g)].map((m) => m[1])) {
      expect(exportControlProviderJurisdiction(provider)).toBe("us");
    }
  });

  it("wraps both preflights and keeps them service-role only", () => {
    for (const fn of ["api_authorize_xometry_beta_worker_dispatch", "api_authorize_provider_worker_dispatch"]) {
      expect(draft).toContain(`create or replace function public.${fn}(`);
      expect(draft).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    expect(draft).toContain("private.export_control_dispatch_denial_for_task(p_work_queue_task_id, 'xometry')");
  });

  it("records marking hits through a service-role-only RPC and audits admin review", () => {
    expect(draft).toMatch(
      /revoke all on function public\.api_record_export_control_marking_hits\([^)]*\)\s+from public, anon, authenticated;/,
    );
    expect(draft).toMatch(/if not public\.is_platform_admin\(\) then\s+raise exception using errcode = '42501', message = 'export_review_admin_required'/);
    expect(draft).toContain("'marking_block_cleared'");
  });
});
