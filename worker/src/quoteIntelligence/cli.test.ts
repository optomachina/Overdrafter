// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runQuoteReviewCli } from "../tools/reviewQuoteIntelligence.js";
const fixture = "worker/src/quoteIntelligence/fixtures/review-synthetic.json";
describe("local review CLI entrypoint", () => {
  it("reads a full synthetic packet and runs every feature without credentials", async () => {
    const result = await runQuoteReviewCli([fixture, "off"], {});
    expect(result).toMatchObject({ localOnly: true, dispatchAllowed: false, publicationAllowed: false });
    expect(result.quote).toHaveProperty("flags"); expect(result.catalog.status).toBe("clarify");
    expect(result.clarification).toHaveProperty("templateId"); expect(result.relevance.retained.length).toBeGreaterThan(0);
    expect(result.audit.length).toBeGreaterThanOrEqual(4);
    expect(result.audit.every((row) => row.reason === "off")).toBe(true);
  });
  it("explicit inference with missing configured key records deterministic fallback", async () => {
    const result = await runQuoteReviewCli([fixture, "shadow", "--jev"], {});
    expect(result.audit.every((row) => row.reason === "unconfigured")).toBe(true);
  });
  it("rejects unsupported switches and mode", async () => {
    await expect(runQuoteReviewCli([fixture, "production"], {})).rejects.toThrow("usage");
    await expect(runQuoteReviewCli([fixture, "apply", "--publish"], {})).rejects.toThrow("usage");
  });
});
