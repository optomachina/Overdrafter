// @vitest-environment node

import { readFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import type { Page } from "patchright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sandboxedChromiumLaunchOptions } from "../../test-support/localPortalBrowserFixture.js";
import { admitPrice } from "../quotes/pricedQuantity.js";
import { readPricedCardQuantity } from "./xometry.js";
import { XOMETRY_LOCATORS } from "./xometryConstraints.js";

const summary = (quantity: string, price = "$43.21") =>
  `<input type="number" value="1"><div class="price-tier"><div kind="discount"><span style="white-space: pre-wrap">${quantity}</span><span> · ${price}</span></div></div>`;

const cases = [
  { row: 1, fixture: "xometry-tier-card-stale-n10-at-qty1.html", totalCents: 43210, reason: "qty_mismatch" },
  { row: 2, fixture: "xometry-tier-card-qty1-ok.html" },
  { row: 3, html: '<input type="number" value="1">', reason: "page_qty_missing" },
  { row: 4, html: summary("Qty 1; Qty 10"), reason: "page_qty_ambiguous" },
  { row: 5, html: summary("Qty\u00a01"), reason: "page_qty_ambiguous" },
  // HTML parsing/rendering normalizes CRLF; the shared raw-text guard still rejects CR.
  { row: 6, html: summary("Qty 1\r\n") },
  { row: 7, html: summary("Qty\r\n10"), reason: "page_qty_ambiguous" },
  { row: 8, html: summary("Qty 1"), race: true, reason: "page_qty_unstable" },
  { row: 9, html: summary("Qty 1"), inputEcho: true, reason: "page_qty_unproven" },
  { row: 10, html: '<input type="number" value="1"><p>Quantity: 1</p>', reason: "page_qty_missing" },
  { row: 11, html: summary("Qty 10 pcs", "$432.10 total / $43.21 each"), requested: 10 },
] as const;

describe("OVD-1094 priced-card quantity design table (offline Chromium)", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, ...sandboxedChromiumLaunchOptions() }); });
  afterAll(async () => { await browser?.close(); });

  it.each(cases)("row $row", async (testCase) => {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    try {
      const html = "fixture" in testCase
        ? await readFile(new URL(`./fixtures/${testCase.fixture}`, import.meta.url), "utf8")
        : testCase.html;
      await page.setContent(html);
      if ("race" in testCase) {
        let count = 0;
        const wait = page.waitForTimeout.bind(page);
        vi.spyOn(page, "waitForTimeout").mockImplementation(async (ms) => {
          expect(ms).toBeGreaterThanOrEqual(250);
          await wait(ms);
          await page.setContent(++count % 2 ? summary("Qty 10", "$432.10") : html);
        });
      }
      const read = await readPricedCardQuantity(page as unknown as Page);
      const quantity = "requested" in testCase ? testCase.requested : 1;
      const verdict = read.ok ? admitPrice({
        requestedQuantity: quantity,
        quantity,
        pageQuantity: "inputEcho" in testCase ? { ...read.value, source: "input_echo" } : read.value,
        unit: { cents: 4321, currency: "USD", label: "each" },
        total: { cents: "totalCents" in testCase ? testCase.totalCents : 4321 * quantity, currency: "USD", label: "total" },
      }) : read;
      if ("reason" in testCase) {
        expect(verdict).toMatchObject({ ok: false, reason: testCase.reason });
        if (!verdict.ok) expect(Object.values(verdict.detail).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
      } else {
        expect(verdict).toMatchObject({ ok: true, value: { quantity, total: { cents: 4321 * quantity } } });
        expect(read).toMatchObject({ ok: true, value: { source: "page_dom" } });
      }
    } finally { await page.close(); }
  });

  it("refuses the original price panel, which prints no card quantity", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(await readFile(new URL("./fixtures/xometry-quote-page-price-panel-2026-10.html", import.meta.url), "utf8"));
      expect(await readPricedCardQuantity(page as unknown as Page)).toMatchObject({ ok: false, reason: "page_qty_missing" });
    } finally { await page.close(); }
  });

  it("retries one changing pair, then returns the exact second stable text", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(summary("Qty 10"));
      const wait = page.waitForTimeout.bind(page);
      let count = 0;
      vi.spyOn(page, "waitForTimeout").mockImplementation(async (ms) => {
        await wait(ms);
        if (++count === 1) await page.setContent(summary("Qty:\t1 pc"));
      });
      expect(await readPricedCardQuantity(page as unknown as Page)).toEqual({
        ok: true, value: { value: 1, sourceText: "Qty:\t1 pc", source: "page_dom" },
      });
      expect(count).toBe(2);
      expect(await page.locator(XOMETRY_LOCATORS.pricedCardQuantity).locator("span").first().innerText()).toBe("Qty:\t1 pc");
    } finally { await page.close(); }
  });
});
