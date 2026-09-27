// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildQuoteLaneScopeSnapshot, parseWorkerSourcingIntent } from "./quoteScope";

describe("buildQuoteLaneScopeSnapshot", () => {
  it("binds the scope to the staged bytes and captured requirement", () => {
    expect(buildQuoteLaneScopeSnapshot({
      part: {
        id: "part-1",
        job_id: "job-1",
        organization_id: "org-1",
        name: "Bracket",
        normalized_key: "bracket",
        cad_file_id: "cad-1",
        drawing_file_id: null,
        quantity: 10,
      },
      cadFile: {
        id: "cad-1",
        job_id: "job-1",
        storage_bucket: "job-files",
        storage_path: "org-1/bracket.step",
        original_name: "bracket.step",
        file_kind: "cad",
      },
      drawingFile: null,
      stagedCadFile: {
        originalName: "bracket.step",
        localPath: "/tmp/bracket.step",
        storageBucket: "job-files",
        storagePath: "org-1/bracket.step",
        trustedContentSha256: "a".repeat(64),
      },
      stagedDrawingFile: null,
      requirement: {
        id: "requirement-1",
        part_id: "part-1",
        description: "Machined bracket",
        part_number: "BR-1",
        revision: "A",
        material: "6061-T6 Aluminum",
        finish: "Black anodize",
        tightest_tolerance_inch: 0.005,
        quantity: 10,
        quote_quantities: [10],
        requested_by_date: "2026-09-01",
        applicable_vendors: ["xometry"],
        updated_at: "2026-08-12T06:00:00Z",
        spec_snapshot: {
          process: "CNC machining",
          requestedByDate: "2026-09-01",
          shipping: { requestedByDateOverride: "2026-09-02", packagingNotes: "Foam" },
        },
      },
      sourcingIntent: {
        destination: {
          confirmationRevision: "1",
          street: "123 Test Ave", city: "Tucson", region: "AZ",
          postalCode: "85701", country: "US", state: "confirmed",
        },
        activeDeadline: "2026-09-10",
      },
      vendor: "xometry",
      requestedQuantity: 10,
    })).toMatchObject({
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
      quantity: 10,
      destination: { confirmationRevision: "1", postalCode: "85701", state: "confirmed" },
      part: {
        id: "part-1",
        cad: { fileId: "cad-1", sha256: "a".repeat(64) },
        drawing: null,
      },
      requirements: {
        id: "requirement-1",
        capturedAt: "2026-08-12T06:00:00Z",
        material: "6061-T6 Aluminum",
        requestedDeliveryDate: "2026-09-10",
        specification: { process: "CNC machining", shipping: { packagingNotes: "Foam" } },
      },
    });
  });

  it("rejects a staged file without a worker digest", () => {
    expect(() => buildQuoteLaneScopeSnapshot({
      part: {
        id: "part-1",
        job_id: "job-1",
        organization_id: "org-1",
        name: "Bracket",
        normalized_key: "bracket",
        cad_file_id: "cad-1",
        drawing_file_id: null,
        quantity: 1,
      },
      cadFile: {
        id: "cad-1",
        job_id: "job-1",
        storage_bucket: "job-files",
        storage_path: "org-1/bracket.step",
        original_name: "bracket.step",
        file_kind: "cad",
      },
      drawingFile: null,
      stagedCadFile: {
        originalName: "bracket.step",
        localPath: "/tmp/bracket.step",
        storageBucket: "job-files",
        storagePath: "org-1/bracket.step",
      },
      stagedDrawingFile: null,
      requirement: {
        id: "requirement-1",
        part_id: "part-1",
        description: null,
        part_number: null,
        revision: null,
        material: "Aluminum",
        finish: null,
        tightest_tolerance_inch: null,
        quantity: 1,
        quote_quantities: [1],
        requested_by_date: null,
        applicable_vendors: ["xometry"],
        updated_at: "2026-08-12T06:00:00Z",
      },
      sourcingIntent: { destination: null, activeDeadline: null },
      vendor: "xometry",
      requestedQuantity: 1,
    })).toThrow("missing its worker-trusted digest");
  });

  it("rejects an inferred or malformed worker sourcing intent", () => {
    expect(() => parseWorkerSourcingIntent({ destination: { state: "inferred" }, activeDeadline: null }))
      .toThrow("confirmed sourcing destination");
    for (const confirmationRevision of [undefined, "", "0", "1.5", 1]) {
      expect(() => parseWorkerSourcingIntent({ destination: {
        state: "confirmed", street: "123 Test Ave", city: "Tucson", region: "AZ",
        postalCode: "85701", country: "US", confirmationRevision,
      }, activeDeadline: null })).toThrow();
    }
    expect(() => parseWorkerSourcingIntent({ destination: null, activeDeadline: "2026-02-31" }))
      .toThrow("active deadline");
  });
});
