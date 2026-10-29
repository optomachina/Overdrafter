// @vitest-environment node

import { readFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import type { Page } from "patchright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sandboxedChromiumLaunchOptions } from "../../test-support/localPortalBrowserFixture.js";
import { admitPrice } from "../quotes/pricedQuantity.js";
import { parseXometryOfferSnapshots } from "./xometryOffers.js";
import { admitXometryPricedOffers, readPricedCardQuantity } from "./xometry.js";
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
  // Chromium process teardown takes ~30s on the macOS runner; assertions keep their normal deadlines.
  afterAll(async () => { await browser?.close(); }, 45_000);

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
    await page.route("**/*", route => route.abort());
    try {
      await page.setContent(await readFile(new URL("./fixtures/xometry-quote-page-price-panel-2026-10.html", import.meta.url), "utf8"));
      expect(await readPricedCardQuantity(page as unknown as Page)).toMatchObject({ ok: false, reason: "page_qty_missing" });
    } finally { await page.close(); }
  });

  it("retries one changing pair, then returns the exact second stable text", async () => {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
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
  // Synthetic layouts below are contracts for the disabled experiment, not live capture evidence.
  async function pricedPage(quantity = 10, explicitUnit = true, count = 1) {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent(Array.from({ length: count }, (_, i) => `<div class="price-tier" data-option-id="tier-${i}"><div>Standard</div><div>5 business days</div><div kind="discount"><div>Qty ${quantity}</div>${explicitUnit ? '<div>$43.21 ea.</div>' : ''}<div>$${(43.21 * quantity).toFixed(2)}</div></div></div>`).join(""));
    const snapshots = await page.locator(".price-tier").evaluateAll(cards => cards.map((card, i) => ({
      selector: ".price-tier", text: (card as HTMLElement).innerText.trim(), attributes: { "data-option-id": `tier-${i}` },
    })));
    const offers = parseXometryOfferSnapshots({ requestedQuantity: quantity, quoteUrl: "https://www.xometry.com/quoting/quote/Q00-TEST", snapshots });
    return { page, offers };
  }

  it("admits parser-produced witnesses and refuses a missing or mismatched offer quantity", async () => {
    const { page, offers } = await pricedPage();
    try {
      expect(offers[0].quantity).toBe(10);
      expect(await admitXometryPricedOffers(page as unknown as Page, offers, 10)).toEqual({ ok: true });
      expect(await admitXometryPricedOffers(page as unknown as Page, [{ ...offers[0], quantity: undefined }], 10)).toMatchObject({ ok: false, reason: "qty_missing" });
      expect(await admitXometryPricedOffers(page as unknown as Page, [{ ...offers[0], quantity: 1 }], 10)).toMatchObject({ ok: false, reason: "qty_mismatch" });
    } finally { await page.close(); }
  });

  it("does not present a derived unit as observed for a multi-piece price", async () => {
    const { page, offers } = await pricedPage(10, false);
    try {
      expect(offers[0].rawPayload.unitPriceExplicit).toBe(false);
      expect(await admitXometryPricedOffers(page as unknown as Page, offers, 10)).toMatchObject({ ok: false, reason: "ambiguous_label" });
    } finally { await page.close(); }
  });

  it.each(["empty", "hidden", "changed", "removed"])("refuses a third offered card whose evidence is %s", async mode => {
    const { page, offers } = await pricedPage(1, true, 3);
    try {
      await page.locator('.price-tier').nth(2).evaluate((card, mode) => {
        const summary = card.querySelector('[kind="discount"]') as HTMLElement;
        if (mode === "empty") summary.textContent = "";
        if (mode === "hidden") summary.style.display = "none";
        if (mode === "changed") summary.lastElementChild!.textContent = "$99.00";
        if (mode === "removed") card.remove();
      }, mode);
      expect(await admitXometryPricedOffers(page as unknown as Page, offers, 1)).toMatchObject({ ok: false });
    } finally { await page.close(); }
  });

  it("propagates a closed page instead of reporting selector drift", async () => {
    const page = await browser.newPage();
    await page.close();
    await expect(readPricedCardQuantity(page as unknown as Page)).rejects.toThrow(/closed/i);
  });

});
