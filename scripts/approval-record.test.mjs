// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  APPROVAL_SCHEMA_ID,
  approvalForHead,
  extractApprovalBlocks,
  formatApprovalBlock,
  parseApprovalComments,
  validateApproval,
} from "./approval-record.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const DIFF = "c".repeat(64);
const OTHER_DIFF = "d".repeat(64);
const NOW = new Date("2026-10-20T00:10:00Z");

const record = (overrides = {}) => ({
  schema: APPROVAL_SCHEMA_ID,
  sha: SHA,
  diff_id: DIFF,
  approver: "blaine",
  card_id: "K2-959",
  timestamp: "2026-10-20T00:00:00Z",
  ...overrides,
});

const comment = (id, body, { login = "optomachina", created = "2026-10-20T00:01:00Z", updated = created } = {}) => ({
  id,
  body,
  created_at: created,
  updated_at: updated,
  user: { login },
});

describe("validateApproval", () => {
  it("accepts a complete record", () => {
    expect(validateApproval(record(), { now: NOW })).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["schema", { schema: "overdrafter.approval/v2" }, "approval.schema"],
    ["sha", { sha: "abc" }, "approval.sha"],
    ["diff_id", { diff_id: "e".repeat(40) }, "approval.diff_id"],
    ["approver", { approver: "grok" }, "approval.approver"],
    ["card_id", { card_id: "" }, "approval.card_id"],
    ["timestamp", { timestamp: "2026-10-20 00:00" }, "approval.timestamp"],
    ["impossible timestamp", { timestamp: "2026-02-30T00:00:00Z" }, "approval.timestamp"],
    ["future timestamp", { timestamp: "2026-10-20T01:00:00Z" }, "is in the future"],
  ])("rejects a bad %s", (_name, overrides, message) => {
    const { ok, errors } = validateApproval(record(overrides), { now: NOW });
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain(message);
  });

  it.each(["schema", "sha", "diff_id", "approver", "card_id", "timestamp"])("requires %s", (field) => {
    const value = record();
    delete value[field];
    expect(validateApproval(value, { now: NOW }).errors).toContain(`approval.${field}: is required`);
  });

  it("rejects unknown fields, including Object.prototype names", () => {
    for (const key of ["classes", "constructor", "__proto__", "valueOf"]) {
      const value = JSON.parse(JSON.stringify(record()));
      Object.defineProperty(value, key, { value: 1, enumerable: true });
      expect(validateApproval(value, { now: NOW }).errors).toContain(`approval.${key}: is not an allowed field`);
    }
  });

  it.each([null, undefined, [], "x", 1])("rejects a non-object %j", (value) => {
    expect(validateApproval(value, { now: NOW }).ok).toBe(false);
  });
});

describe("parseApprovalComments", () => {
  it("round-trips a formatted block from a trusted login", () => {
    const body = `Approved.\n\n${formatApprovalBlock(record())}\n`;
    expect(extractApprovalBlocks(body)).toHaveLength(1);
    const { approvals, rejected } = parseApprovalComments([comment(1, body)], { trustedLogins: ["optomachina"] });
    expect(rejected).toEqual([]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ comment_id: 1, author: "optomachina", approval: record() });
  });

  it("rejects untrusted authors, and trusts nobody without a list", () => {
    const body = formatApprovalBlock(record());
    expect(parseApprovalComments([comment(1, body, { login: "mallory" })], { trustedLogins: ["optomachina"] }).rejected[0].reason).toBe("untrusted_author");
    expect(parseApprovalComments([comment(1, body)]).approvals).toEqual([]);
  });

  it("rejects edited comments, missing timestamps, bad JSON and schema errors", () => {
    const trustedLogins = ["optomachina"];
    const cases = [
      [comment(1, formatApprovalBlock(record()), { updated: "2026-10-20T00:02:00Z" }), "edited_comment"],
      [{ ...comment(2, formatApprovalBlock(record())), updated_at: undefined }, "missing_comment_timestamps"],
      [comment(3, "```overdrafter-approval\n{nope\n```"), "invalid_json"],
      [comment(4, formatApprovalBlock(record({ approver: "someone" }))), "schema_error"],
      [comment(5, formatApprovalBlock(record({ timestamp: "2026-10-20T00:30:00Z" }))), "schema_error"],
    ];
    for (const [input, reason] of cases) {
      const { approvals, rejected } = parseApprovalComments([input], { trustedLogins });
      expect(approvals).toEqual([]);
      expect(rejected[0].reason).toBe(reason);
    }
  });

  it("ignores other fences and non-list input", () => {
    expect(parseApprovalComments([comment(1, "```json\n{}\n```")], { trustedLogins: ["optomachina"] })).toEqual({ approvals: [], rejected: [] });
    expect(parseApprovalComments(null, { trustedLogins: ["optomachina"] })).toEqual({ approvals: [], rejected: [] });
  });
});

describe("approvalForHead", () => {
  const entries = (approval) => parseApprovalComments([comment(1, formatApprovalBlock(approval))], { trustedLogins: ["optomachina"] }).approvals;

  it("binds by head sha", () => {
    expect(approvalForHead(entries(record()), { headSha: SHA, headDiffId: OTHER_DIFF })?.comment_id).toBe(1);
  });

  it("binds by an equal diff_id at another sha", () => {
    expect(approvalForHead(entries(record({ sha: OTHER_SHA })), { headSha: SHA, headDiffId: DIFF })?.comment_id).toBe(1);
  });

  it("does not bind another sha with a different diff_id", () => {
    expect(approvalForHead(entries(record({ sha: OTHER_SHA })), { headSha: SHA, headDiffId: OTHER_DIFF })).toBeNull();
  });

  it.each([null, undefined, "", "not-hex"])("never matches by diff_id when the head diff_id is %j", (headDiffId) => {
    expect(approvalForHead(entries(record({ sha: OTHER_SHA })), { headSha: SHA, headDiffId })).toBeNull();
  });
});
