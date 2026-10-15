import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPORT_CONTROL_ANSWER_OPTIONS,
  EXPORT_CONTROL_TERMS_VERSION,
  ExportControlUploadBlockedError,
  evaluateExportControlAnswer,
  getExportControlBlockMessage,
  isExportControlUploadBlockReason,
  registerExportControlDeclarationPrompter,
  requestExportControlAnswer,
} from "./export-control";

describe("OVD-723 export-control answer evaluation", () => {
  it("allows only not_controlled", () => {
    expect(evaluateExportControlAnswer("not_controlled")).toEqual({ allowed: true, answer: "not_controlled" });
  });

  it.each(["controlled", "unsure"])("blocks %s as not clean", (answer) => {
    expect(evaluateExportControlAnswer(answer)).toEqual({ allowed: false, reasonCode: "export_declaration_not_clean" });
  });

  it.each([null, undefined, "", "EAR99", "NOT_CONTROLLED", 1, {}])("treats %j as a missing declaration", (answer) => {
    expect(evaluateExportControlAnswer(answer)).toEqual({ allowed: false, reasonCode: "export_declaration_missing" });
  });

  it("offers exactly three answers with no default", () => {
    expect(EXPORT_CONTROL_ANSWER_OPTIONS.map((option) => option.value)).toEqual([
      "not_controlled",
      "controlled",
      "unsure",
    ]);
  });

  it("recognizes only the upload block reason codes", () => {
    expect(isExportControlUploadBlockReason("export_review_pending")).toBe(true);
    expect(isExportControlUploadBlockReason("toString")).toBe(false);
    expect(isExportControlUploadBlockReason("file_upload_empty")).toBe(false);
  });

  it("explains a not-clean block in the error message", () => {
    const error = new ExportControlUploadBlockedError("export_declaration_not_clean");
    expect(error.message).toBe(getExportControlBlockMessage("export_declaration_not_clean"));
    expect(error.message).toMatch(/Nothing was uploaded/);
  });

  it("keeps the terms version in sync with the SQL draft", () => {
    const draft = readFileSync("docs/migration-drafts/ovd-723.sql", "utf8");
    expect(draft).toContain(`'${EXPORT_CONTROL_TERMS_VERSION}'`);
  });
});

describe("OVD-723 export-control prompter", () => {
  it("returns null without a registered prompter", async () => {
    await expect(requestExportControlAnswer()).resolves.toBeNull();
  });

  it("returns the registered prompter's answer and stops after unregister", async () => {
    const unregister = registerExportControlDeclarationPrompter(async () => "unsure");
    await expect(requestExportControlAnswer()).resolves.toBe("unsure");
    unregister();
    await expect(requestExportControlAnswer()).resolves.toBeNull();
  });

  it("returns null for an invalid answer or a failed prompt", async () => {
    let unregister = registerExportControlDeclarationPrompter(async () => "maybe" as never);
    await expect(requestExportControlAnswer()).resolves.toBeNull();
    unregister();
    unregister = registerExportControlDeclarationPrompter(() => Promise.reject(new Error("closed")));
    await expect(requestExportControlAnswer()).resolves.toBeNull();
    unregister();
  });
});
