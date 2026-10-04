import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

// The client-comparison fixture part. Every offer is a trusted live Xometry
// offer except: "Archived Economy" (quoted 20 days ago, stale), "Lapsed
// Standard" (vendor validity expired), and the Fictiv "Global Standard" offer
// (provider not production-certified for live offers, so never listed).
const COMPARISON_ROUTE = "/parts/fx-job-comparison?fixture=client-comparison&debug=1";
const APP_ENTRY_TIMEOUT_MS = 20_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const DOMESTIC_LANES = ["US Economy", "US Standard", "US Expedite"];
const ALL_SOURCING_LANE_COUNT = 7;
const CHART_NAME = "Quote comparison by ready-to-ship working days and quoted total";
const SIGN_IN_NOTE =
  "Vendor quote links open the supplier's purchasing page. Vendor sign-in or a vendor-issued guest link may be required.";

function quoteInformation(page: Page) {
  return page.getByRole("region", { name: "Quote information" });
}

function decisionPanel(page: Page) {
  return quoteInformation(page)
    .locator("section")
    .filter({ has: page.getByText("Quote comparison", { exact: true }) });
}

function quoteRows(panel: Locator) {
  return panel
    .getByRole("table")
    .getByRole("row")
    .filter({ has: panel.page().getByRole("cell") });
}

function quoteRow(panel: Locator, lane: string) {
  return quoteRows(panel).filter({ has: panel.page().getByText(lane, { exact: true }) });
}

function selectedRow(panel: Locator) {
  return panel.getByRole("row", { selected: true });
}

function summaryFact(panel: Locator, label: string) {
  return panel
    .getByTestId("selected-option-summary")
    .locator("div")
    .filter({ has: panel.page().getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }) })
    .getByRole("definition");
}

function comparisonChart(panel: Locator) {
  return panel.getByRole("group", { name: CHART_NAME });
}

function chartPoints(chart: Locator) {
  return chart.locator(".recharts-scatter-symbol");
}

async function openComparison(page: Page) {
  await page.goto(COMPARISON_ROUTE);
  const panel = decisionPanel(page);
  await expect(panel.getByRole("button", { name: "US-only sourcing" })).toBeVisible({
    timeout: APP_ENTRY_TIMEOUT_MS,
  });
  await expect(quoteRows(panel).first()).toBeVisible();
  await expect(comparisonChart(panel)).toBeVisible();
  return panel;
}

async function showAllSourcing(panel: Locator) {
  await panel.getByRole("button", { name: "US-only sourcing" }).click();
  await expect(panel.getByRole("button", { name: "All sourcing" })).toBeVisible();
}

/** Hover each plotted point until its tooltip names the requested quoted total. */
async function findChartPoint(chart: Locator, quotedTotal: string) {
  const points = chartPoints(chart);
  const tooltipTotal = chart.getByText(/^Quoted total: /);
  const pointCount = await points.count();
  let previousTotal: string | null = null;

  for (let index = 0; index < pointCount; index += 1) {
    const point = points.nth(index);
    await point.hover();
    await expect.poll(async () => {
      if (!(await tooltipTotal.isVisible())) {
        return previousTotal;
      }
      return tooltipTotal.textContent();
    }).not.toBe(previousTotal);
    previousTotal = await tooltipTotal.textContent();

    if (previousTotal === `Quoted total: ${quotedTotal}`) {
      return point;
    }
  }

  throw new Error(`No plotted point is labelled "Quoted total: ${quotedTotal}".`);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

/**
 * Tailwind's `outline-none` is a 2px transparent outline, so a bare
 * "outline-style is not none" check would pass with no visible indicator.
 * Require a non-transparent outline or shadow layer with real extent.
 */
async function activeElementHasVisibleFocusIndicator(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return false;
    }

    const style = getComputedStyle(element);
    const isTransparent = (color: string) =>
      color === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color.trim());
    const outlineVisible =
      style.outlineStyle !== "none" &&
      Number.parseFloat(style.outlineWidth) > 0 &&
      !isTransparent(style.outlineColor);
    const shadowLayers = style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/);
    const shadowVisible = shadowLayers.some((layer) => {
      const color = layer.match(/rgba?\([^)]*\)/)?.[0] ?? "";
      const lengths = (layer.replace(/rgba?\([^)]*\)/, "").match(/-?\d*\.?\d+px/g) ?? []).map((value) =>
        Math.abs(Number.parseFloat(value)),
      );
      // Offsets alone draw nothing; a visible ring needs blur or spread.
      const extent = (lengths[2] ?? 0) + (lengths[3] ?? 0);
      return color !== "" && !isTransparent(color) && extent > 0;
    });

    return outlineVisible || shadowVisible;
  });
}

async function tabUntilFocused(page: Page, target: Locator, maxPresses: number) {
  for (let presses = 0; presses <= maxPresses; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return presses;
    }
    await page.keyboard.press("Tab");
  }

  throw new Error(`Focus did not reach the target within ${maxPresses} Tab presses.`);
}

test.describe("client quote comparison decisions", { tag: "@fixture" }, () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test("(a) groups the domestic Xometry variants under one provider entry", async ({ page }) => {
    const panel = await openComparison(page);

    await expect(panel.getByRole("button", { name: "US-only sourcing" })).toHaveAttribute("aria-pressed", "true");
    await expect(quoteRows(panel)).toHaveCount(DOMESTIC_LANES.length);
    for (const lane of DOMESTIC_LANES) {
      await expect(quoteRow(panel, lane)).toHaveCount(1);
    }
    await expect(panel.getByRole("cell", { name: /^Xometry\b/ })).toHaveCount(1);
    await expect(panel.getByRole("cell", { name: /^Xometry 3 variants\b/ })).toHaveCount(1);
    await expect(panel.getByRole("cell", { name: /^↳ US (Economy|Standard|Expedite)\b/ })).toHaveCount(2);

    // Wider sourcing adds variants to the same provider entry instead of new entries.
    await showAllSourcing(panel);
    await expect(quoteRows(panel)).toHaveCount(ALL_SOURCING_LANE_COUNT);
    await expect(panel.getByRole("cell", { name: /^Xometry\b/ })).toHaveCount(1);
    await expect(panel.getByRole("cell", { name: /^↳ / })).toHaveCount(ALL_SOURCING_LANE_COUNT - 1);
  });

  test("(b) keeps the table row and chart point selection on the same offer", async ({ page }) => {
    const panel = await openComparison(page);
    const chart = comparisonChart(panel);

    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Economy");

    // Chart point -> the same offer's table row. This runs before any table
    // row takes focus: while a row is focused, the first point click is
    // intermittently dropped (reported with this spec, not fixed here).
    await (await findChartPoint(chart, "$485.00")).click();
    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Expedite");
    await expect(summaryFact(panel, "Quoted total")).toHaveText("$485.00");

    // Table row -> current selection. The chart exposes no accessible
    // selected state for points, so the row-to-point direction has no role or
    // text signal to assert.
    await quoteRow(panel, "US Standard").getByRole("cell").first().click();
    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Standard");
    await expect(summaryFact(panel, "Quoted total")).toHaveText("$365.00");
  });

  test("(c) plots offers as points only, with no line or area series", async ({ page }) => {
    const panel = await openComparison(page);
    const chart = comparisonChart(panel);

    for (const showAll of [false, true]) {
      if (showAll) {
        await showAllSourcing(panel);
      }
      const rowCount = await quoteRows(panel).count();
      await expect(chartPoints(chart)).toHaveCount(rowCount);
      for (const seriesSelector of [".recharts-line", ".recharts-area", ".recharts-curve", ".recharts-scatter-line"]) {
        await expect(chart.locator(seriesSelector)).toHaveCount(0);
      }
    }
  });

  test("(d) US-only hides foreign and unknown origins; all sourcing labels them truthfully", async ({ page }) => {
    const panel = await openComparison(page);

    for (const lane of DOMESTIC_LANES) {
      await expect(quoteRow(panel, lane).getByRole("cell").nth(1)).toHaveAccessibleName(`${lane} US Domestic`);
    }
    await expect(quoteRow(panel, "Overseas Economy")).toHaveCount(0);
    // Current filter: US-only keeps only explicitly domestic offers, so the
    // no-origin offer is hidden there and shown, as Unknown, in all sourcing.
    await expect(quoteRow(panel, "Partner Network")).toHaveCount(0);

    await showAllSourcing(panel);
    await expect(quoteRow(panel, "Overseas Economy").getByRole("cell").nth(1)).toHaveAccessibleName(
      "Overseas Economy International International",
    );
    await expect(quoteRow(panel, "Partner Network").getByRole("cell").nth(1)).toHaveAccessibleName(
      "Partner Network Unknown",
    );
    await (await findChartPoint(comparisonChart(panel), "$335.00")).hover();
    await expect(comparisonChart(panel).getByText("Xometry · standard · Unknown", { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: "All sourcing" }).click();
    await expect(panel.getByRole("button", { name: "US-only sourcing" })).toBeVisible();
    await expect(quoteRow(panel, "Overseas Economy")).toHaveCount(0);
    await expect(quoteRow(panel, "Partner Network")).toHaveCount(0);
    await expect(quoteRows(panel)).toHaveCount(DOMESTIC_LANES.length);
  });

  test("(e) shows a missing lead time as unavailable and never ranks it fastest", async ({ page }) => {
    const panel = await openComparison(page);
    await showAllSourcing(panel);
    const chart = comparisonChart(panel);
    const customFinish = quoteRow(panel, "Custom Finish");

    await expect(customFinish.getByRole("cell").nth(4)).toHaveText("Unavailable");
    await expect(chart.getByText("Lead not quoted", { exact: true })).toBeVisible();
    await (await findChartPoint(chart, "$295.00")).hover();
    await expect(chart.getByText("Ready to ship: Not quoted", { exact: true })).toBeVisible();

    const presets = panel.getByRole("group", { name: "Quote preset" });
    await presets.getByRole("button", { name: "Fast" }).click();
    await expect(presets.getByRole("button", { name: "Fast" })).toHaveAttribute("aria-pressed", "true");
    const fastPicks = quoteRows(panel).filter({ hasText: "Fast pick" });
    await expect(fastPicks).toHaveCount(1);
    await expect(fastPicks).toContainText("US Expedite");
    await expect(customFinish).not.toContainText("Fast pick");

    await panel.getByRole("button", { name: "Sort providers by working days" }).click();
    await expect(quoteRows(panel).first()).toContainText("US Expedite");
    await expect(quoteRows(panel).last()).toContainText("Custom Finish");
  });

  test("(f) never lists the stale offer and never lets the expired offer be selected", async ({ page }) => {
    const panel = await openComparison(page);
    const chart = comparisonChart(panel);

    // The stale offer is neither listed nor selectable in either sourcing view.
    await expect(page.getByText("Archived Economy")).toHaveCount(0);
    await expect(chartPoints(chart)).toHaveCount(DOMESTIC_LANES.length);
    await showAllSourcing(panel);
    await expect(quoteRows(panel)).toHaveCount(ALL_SOURCING_LANE_COUNT);
    await expect(page.getByText("Archived Economy")).toHaveCount(0);
    await expect(chartPoints(chart)).toHaveCount(ALL_SOURCING_LANE_COUNT);

    // Positive control: a fresh offer in the same view is live and selectable.
    await (await findChartPoint(chart, "$365.00")).click();
    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Standard");
    await expect(panel.getByText("Current selection", { exact: true })).toBeVisible();
    await expect(summaryFact(panel, "Quote status")).toContainText("Recently collected");

    // The expired offer is shown only as blocked and cannot become the
    // selection. Its point click sits between two point clicks that do select,
    // so a dropped click cannot make this pass.
    const lapsed = quoteRow(panel, "Lapsed Standard");
    await expect(lapsed).toContainText("Needs review before selection");
    await expect(lapsed).toHaveAttribute("tabindex", "-1");
    await (await findChartPoint(chart, "$350.00")).click();
    await expect(lapsed).toHaveAttribute("aria-selected", "false");
    await expect(selectedRow(panel)).toContainText("US Standard");
    await (await findChartPoint(chart, "$485.00")).click();
    await expect(selectedRow(panel)).toContainText("US Expedite");

    await lapsed.getByRole("cell").first().click();
    await expect(lapsed).toHaveAttribute("aria-selected", "false");
    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Expedite");
    await quoteRow(panel, "US Standard").getByRole("cell").first().click();
    await expect(selectedRow(panel)).toContainText("US Standard");
    await expect(summaryFact(panel, "Quoted total")).toHaveText("$365.00");
  });

  test("(g) opens vendor quote links over https without opener access", async ({ page }) => {
    const panel = await openComparison(page);

    await panel.getByText("Response source facts", { exact: true }).click();
    const panelLinks = panel.getByRole("link");
    await expect(panelLinks).toHaveCount(DOMESTIC_LANES.length + 1);
    await expect(panel.getByRole("link", { name: "Open from Xometry" })).toHaveCount(DOMESTIC_LANES.length);
    await expect(panel.getByRole("link", { name: "Open vendor quote from Xometry" })).toHaveCount(1);

    for (const link of await panelLinks.all()) {
      expect(await link.getAttribute("href")).toMatch(/^https:\/\//);
      const relTokens = (await link.getAttribute("rel"))?.split(/\s+/) ?? [];
      expect(relTokens).toContain("noopener");
      expect(relTokens).toContain("noreferrer");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("title", /Vendor sign-in or guest access may be required\./);
    }
    await expect(panel.getByText(SIGN_IN_NOTE, { exact: true })).toBeVisible();

    // Official RFQ links outside the decision panel currently carry
    // rel="noreferrer" only; the HTML standard makes noreferrer imply noopener.
    const sourcingPaths = quoteInformation(page).getByRole("region", { name: "Additional sourcing paths" });
    await sourcingPaths.getByText("Additional sourcing paths", { exact: true }).click();
    const rfqLinks = sourcingPaths.getByRole("link", { name: "Open RFQ" });
    await expect(rfqLinks.first()).toBeVisible();
    for (const link of await rfqLinks.all()) {
      expect(await link.getAttribute("href")).toMatch(/^https:\/\//);
      expect((await link.getAttribute("rel"))?.split(/\s+/) ?? []).toContain("noreferrer");
      await expect(link).toHaveAttribute("target", "_blank");
    }
  });

  test("(h) keeps order, checkout, and payment controls out of the decision panel", async ({ page }) => {
    const panel = await openComparison(page);
    // The header's "Review order" action opens the legacy procurement handoff
    // route, which this spec deliberately does not assert on.
    const orderOrPaymentControl =
      /\b(place|submit|confirm|complete)\s+(an\s+|the\s+)?order\b|\border\s+now\b|\bcheck\s*out\b|\bpay(ment)?\b|\bpurchase\b|\bbuy\b/i;

    for (const showAll of [false, true]) {
      if (showAll) {
        await showAllSourcing(panel);
      }
      // Positive control: the panel scope does contain interactive controls.
      await expect(panel.getByRole("button", { name: "Exclude" }).first()).toBeVisible();
      for (const role of ["button", "link", "menuitem", "checkbox", "radio"] as const) {
        await expect(panel.getByRole(role, { name: orderOrPaymentControl, includeHidden: true })).toHaveCount(0);
      }
      await expect(
        panel.getByRole("textbox", { name: /card|cvc|cvv|expir|billing/i, includeHidden: true }),
      ).toHaveCount(0);
    }
  });

  test("(i) selects a quote and reaches its vendor link with the keyboard alone", async ({ page }) => {
    const panel = await openComparison(page);
    const firstRow = quoteRows(panel).first();
    const firstLane = (await firstRow.getByRole("cell").nth(1).getByRole("paragraph").first().textContent()) ?? "";
    expect(DOMESTIC_LANES).toContain(firstLane);
    const row = quoteRow(panel, firstLane);
    await expect(row).toHaveAttribute("aria-selected", "false");

    await tabUntilFocused(page, row, 250);
    await expect(row).toBeFocused();
    expect(await activeElementHasVisibleFocusIndicator(page)).toBe(true);

    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toBeFocused();

    const vendorLink = row.getByRole("link", { name: "Open from Xometry" });
    await tabUntilFocused(page, vendorLink, 3);
    await expect(vendorLink).toBeFocused();
    expect(await activeElementHasVisibleFocusIndicator(page)).toBe(true);

    // Space selects the next keyboard-reachable row as well.
    const secondLane = (await quoteRows(panel).nth(1).getByRole("cell").nth(1).getByRole("paragraph").first().textContent()) ?? "";
    const secondRow = quoteRow(panel, secondLane);
    await tabUntilFocused(page, secondRow, 2);
    await page.keyboard.press(" ");
    await expect(secondRow).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveAttribute("aria-selected", "false");
  });
});

test.describe("client quote comparison on a phone", { tag: "@fixture" }, () => {
  test.use({ viewport: PHONE_VIEWPORT, hasTouch: true });

  test("fits the viewport and selects a quote by tap", async ({ page }) => {
    const panel = await openComparison(page);
    await panel.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);

    await quoteRow(panel, "US Expedite").getByRole("cell").first().tap();
    await expect(selectedRow(panel)).toHaveCount(1);
    await expect(selectedRow(panel)).toContainText("US Expedite");
    await expect(summaryFact(panel, "Quoted total")).toHaveText("$485.00");

    await panel.getByRole("button", { name: "US-only sourcing" }).tap();
    await expect(panel.getByRole("button", { name: "All sourcing" })).toBeVisible();
    await expect(quoteRows(panel)).toHaveCount(ALL_SOURCING_LANE_COUNT);
    await expectNoHorizontalOverflow(page);

    await quoteRow(panel, "Partner Network").getByRole("cell").first().tap();
    await expect(selectedRow(panel)).toContainText("Partner Network");
    await expectNoHorizontalOverflow(page);
  });
});
