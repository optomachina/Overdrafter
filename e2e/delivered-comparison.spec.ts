import { expect, test, type Page } from "@playwright/test";

// The ordinary fixture server does not serve this synthetic page.
test.skip(({ baseURL }) => baseURL !== "http://127.0.0.1:4175", "Requires e2e/delivered-comparison.config.ts; this is not a browser pass.");

const FIXTURE = "/fixture/delivered-comparison";
const CHEAPEST_WITH_DEADLINE = [
  "protolabs-overlap",
  "xometry-standard",
  "xometry-express",
  "sendcutsend-unknown",
  "fictiv-lead",
  "protolabs-economy",
];

async function open(page: Page, width: number) {
  const external: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4175") {
      external.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(FIXTURE);
  await expect(page.getByTestId("quote-vendor-table")).toBeVisible();
  return { external, pageErrors };
}

function rowKeys(page: Page) {
  return page.getByTestId("quote-vendor-table").locator("tbody tr[data-quote-key]").evaluateAll(
    (rows) => rows.map((row) => row.getAttribute("data-quote-key")),
  );
}

function row(page: Page, key: string) {
  return page.getByTestId("quote-vendor-table").locator(`tr[data-quote-key="${key}"]`);
}

for (const { name, width, touch } of [
  { name: "desktop", width: 1280, touch: false },
  { name: "mobile", width: 390, touch: true },
]) {
  test.describe(`@fixture OVD-571 delivered comparison (${name})`, () => {
    test.use({ hasTouch: touch, isMobile: touch });

    test("plots delivered dates and OTD, keeps every option accessible, and shows no winner", async ({ page }) => {
      const { external, pageErrors } = await open(page, width);
      const chart = page.getByRole("group", { name: "Quote comparison by delivered date and expected out-the-door cost" });
      await expect(chart).toBeVisible();
      await expect(chart.getByText("Delivered date")).toBeVisible();
      await expect(chart.getByText("Expected OTD (out-the-door)")).toBeVisible();
      // Overlapping options are separate points: no jitter, no collapse.
      await expect(page.locator('[data-quote-point="protolabs-overlap"]')).toHaveCount(1);
      await expect(page.locator('[data-quote-point="xometry-standard"]')).toHaveCount(1);
      const overlapBox = await page.locator('[data-quote-point="protolabs-overlap"] circle').last().boundingBox();
      const standardBox = await page.locator('[data-quote-point="xometry-standard"] circle').last().boundingBox();
      expect(overlapBox).not.toBeNull();
      expect(overlapBox).toEqual(standardBox);
      // Unknown arrival is listed, never plotted.
      await expect(page.locator('[data-quote-point="sendcutsend-unknown"]')).toHaveCount(0);
      await expect(page.getByRole("list", { name: /Not plotted/ }).getByRole("button", { name: /SendCutSend/ })).toBeVisible();
      // One color per provider: both Xometry points share a fill, Protolabs differs.
      const fill = (key: string) => page.locator(`[data-quote-point="${key}"] circle`).last().getAttribute("fill");
      expect(await fill("xometry-express")).toBe(await fill("xometry-standard"));
      expect(await fill("protolabs-economy")).toBe(await fill("protolabs-overlap"));
      expect(await fill("xometry-express")).not.toBe(await fill("protolabs-overlap"));

      expect(await rowKeys(page)).toEqual(CHEAPEST_WITH_DEADLINE);
      await expect(row(page, "protolabs-economy")).toHaveAttribute("data-deadline-status", "late");
      await expect(row(page, "protolabs-economy")).toContainText("Misses deadline");
      await expect(row(page, "sendcutsend-unknown")).toContainText("Arrival unknown");
      await expect(row(page, "sendcutsend-unknown")).toContainText("≥ $40.00");
      await expect(row(page, "fictiv-lead")).toContainText("After Thu, Oct 15, 2026");
      await expect(page.getByText(/pick$/)).toHaveCount(0);
      await expect(page.getByText("Recommended starting point")).toHaveCount(0);
      await expect(page.getByTestId("quote-vendor-table").locator("[aria-selected='true']")).toHaveCount(0);
      // Concealed overseas result is not shown anywhere.
      await expect(page.getByText("RapidDirect")).toHaveCount(0);
      await expect(page.getByTestId("quote-request-completion-notice")).toHaveCount(0);
      expect(external).toEqual([]);
      expect(pageErrors).toEqual([]);
    });

    test("deadline line moves by keyboard and by drag/touch, with the date shown", async ({ page }) => {
      await open(page, width);
      const slider = page.getByRole("slider", { name: "Deadline" });
      await expect(slider).toHaveAttribute("aria-valuetext", "Thu, Oct 22, 2026");
      await expect(slider).toContainText("Deadline Oct 22");
      await slider.focus();
      for (let index = 0; index < 9; index += 1) {
        await page.keyboard.press("ArrowRight");
      }
      await expect(slider).toHaveAttribute("aria-valuetext", "Sat, Oct 31, 2026");
      await expect(slider).toBeFocused();
      await expect(page.getByTestId("deadline-summary")).toContainText("Sat, Oct 31, 2026");
      expect((await rowKeys(page))[0]).toBe("protolabs-economy");
      await page.getByRole("button", { name: "Reset to confirmed deadline" }).click();
      await expect(slider).toHaveAttribute("aria-valuetext", "Thu, Oct 22, 2026");

      const track = await page.getByTestId("deadline-track").boundingBox();
      const handle = await slider.boundingBox();
      expect(track && handle).toBeTruthy();
      const startX = handle!.x + handle!.width / 2;
      const y = handle!.y + handle!.height / 2;
      const endX = track!.x + track!.width * 0.05;
      if (touch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (startX + endX) / 2, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: endX, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(endX, y, { steps: 6 });
        await page.mouse.up();
      }
      const moved = await slider.getAttribute("aria-valuetext");
      expect(moved).not.toBe("Thu, Oct 22, 2026");
      expect(Date.parse(moved!)).toBeLessThan(Date.parse("2026-10-22"));
      await expect(page.getByTestId("deadline-summary")).toContainText(moved!);
    });

    test("only Cheapest and Fastest table modes, operable by keyboard", async ({ page }) => {
      await open(page, width);
      const group = page.getByRole("radiogroup", { name: "Table order" });
      await expect(group.getByRole("radio")).toHaveText(["Cheapest", "Fastest"]);
      const cheapest = group.getByRole("radio", { name: "Cheapest" });
      await expect(cheapest).toHaveAttribute("aria-checked", "true");
      await cheapest.focus();
      await page.keyboard.press("ArrowRight");
      const fastest = group.getByRole("radio", { name: "Fastest" });
      await expect(fastest).toHaveAttribute("aria-checked", "true");
      await expect(fastest).toBeFocused();
      expect(await rowKeys(page)).toEqual([
        "xometry-express",
        "fictiv-lead",
        "protolabs-overlap",
        "xometry-standard",
        "protolabs-economy",
        "sendcutsend-unknown",
      ]);
    });

    test("arrivals preserve selection, focus and viewport, then the terminal notice appears", async ({ page }) => {
      await open(page, width);
      await row(page, "xometry-standard").click();
      await expect(row(page, "xometry-standard")).toHaveAttribute("aria-selected", "true");
      const focused = row(page, "protolabs-economy");
      await focused.focus();
      await page.keyboard.press("Space");
      await expect(focused).toHaveAttribute("aria-selected", "true");
      await focused.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await focused.boundingBox();

      await page.evaluate(() => window.__ovd571Arrive?.());
      await expect(row(page, "quickparts-arriving")).toBeVisible();

      await expect(focused).toBeFocused();
      await expect(focused).toHaveAttribute("aria-selected", "true");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await focused.boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);

      const notice = page.getByTestId("quote-request-completion-notice");
      await expect(notice).toHaveAttribute("role", "status");
      await expect(notice).toHaveText(/Quote request complete: 7 options from 5 providers\./);
      await expect(notice).not.toContainText(/RapidDirect|overseas|hidden/i);
      await notice.getByRole("button", { name: "Dismiss request completion notice" }).click();
      await expect(notice).toHaveCount(0);
    });
  });
}
