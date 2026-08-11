import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

const CLIENT_ROUTES = [
  "/parts?fixture=client-quoted&debug=1",
  "/quotes?fixture=client-quoted&debug=1",
  "/search?fixture=client-quoted&debug=1",
  "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1",
  "/quotes/Z5QF44?fixture=client-published&debug=1",
] as const;

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    windowScrollY: window.scrollY,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.windowScrollY).toBe(0);
}

async function expectOverlayOwnsItsCenter(page: Page, overlay: Locator) {
  const ownsCenter = await overlay.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return topElement === element || element.contains(topElement);
  });

  expect(ownsCenter).toBe(true);
}

async function expectTooltipAboveWorkspace(page: Page, tooltip: Locator) {
  const geometry = await tooltip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    let current: Element | null = element;
    let maximumZIndex = 0;

    while (current) {
      const zIndex = Number.parseInt(getComputedStyle(current).zIndex, 10);
      if (Number.isFinite(zIndex)) {
        maximumZIndex = Math.max(maximumZIndex, zIndex);
      }
      current = current.parentElement;
    }

    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      zIndex: maximumZIndex,
    };
  });

  expect(geometry.zIndex).toBeGreaterThan(40);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(geometry.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
}

async function expectContainedBy(container: Locator, content: Locator) {
  const containerBounds = await container.boundingBox();
  const contentBounds = await content.boundingBox();

  expect(containerBounds).not.toBeNull();
  expect(contentBounds).not.toBeNull();
  expect(contentBounds!.x).toBeGreaterThanOrEqual(containerBounds!.x);
  expect(contentBounds!.y).toBeGreaterThanOrEqual(containerBounds!.y);
  expect(contentBounds!.x + contentBounds!.width).toBeLessThanOrEqual(
    containerBounds!.x + containerBounds!.width,
  );
  expect(contentBounds!.y + contentBounds!.height).toBeLessThanOrEqual(
    containerBounds!.y + containerBounds!.height,
  );
}

test.describe("authenticated client shell contract", () => {
  test("keeps one application frame across every launch client route", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });

    for (const route of CLIENT_ROUTES) {
      await page.goto(route);
      await expect(page.locator("[data-client-shell]")).toBeVisible();
      await expect(page.getByRole("banner")).toHaveCount(1);
      await expect(page.locator('[data-workspace-scroll="primary"]')).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(1);
      await expectNoDocumentOverflow(page);
    }
  });

  test("exits fixture mode without leaving fixture controls over the live app", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    const fixturePanel = page.locator("[data-fixture-panel]");
    await expect(fixturePanel).toBeVisible();
    await expect(fixturePanel).toHaveCSS("position", "static");

    await page.getByRole("button", { name: "Exit" }).click();

    await expect
      .poll(() => {
        const currentUrl = new URL(page.url());
        return `${currentUrl.pathname}${currentUrl.search}`;
      })
      .toBe("/?auth=signin");
    await expect(fixturePanel).toHaveCount(0);
  });

  test("collapses without remounting or moving navigation icons and keeps overlays above content", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts?fixture=client-quoted&debug=1");

    const iconSelectors = ["Parts", "Quotes", "Search"].map(
      (label) => `svg[data-navigation-icon="${label}"]`,
    );
    const iconHandles = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).elementHandle()),
    );
    const before = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).boundingBox()),
    );

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.getByRole("complementary")).toHaveCSS("width", "52px");

    const after = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).boundingBox()),
    );

    for (const [index, handle] of iconHandles.entries()) {
      expect(handle).not.toBeNull();
      expect(before[index]).not.toBeNull();
      expect(after[index]).not.toBeNull();
      expect(after[index]!.x).toBeCloseTo(before[index]!.x, 1);
      expect(after[index]!.y).toBeCloseTo(before[index]!.y, 1);
      const retained = await handle!.evaluate(
        (element, selector) => element === document.querySelector(selector),
        iconSelectors[index],
      );
      expect(retained).toBe(true);
    }

    await page.getByRole("link", { name: "Quotes" }).hover();
    const tooltip = page.getByRole("tooltip", { name: "Quotes" });
    await expect(tooltip).toBeVisible();
    await expectTooltipAboveWorkspace(page, tooltip);

    await page.getByRole("button", { name: /open account menu/i }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expectOverlayOwnsItsCenter(page, menu);
  });

  test("gives the workspace and inspector independent desktop geometry", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    const workspace = page.locator('[data-workspace-scroll="primary"]');
    const inspector = page.locator('[data-workspace-inspector="desktop"]');
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveCSS("width", "336px");

    const workspaceScrollTop = await workspace.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });

    expect(workspaceScrollTop).toBeGreaterThan(0);
    await expect(page.getByRole("banner")).toHaveCSS("height", "56px");
    await expectNoDocumentOverflow(page);
  });

  test("keeps the part evidence and quote comparison in a stable responsive hierarchy", async ({ page }) => {
    const partRoute = "/parts/fx-job-published?fixture=client-published&debug=1";

    for (const viewport of [
      { width: 1512, height: 751 },
      { width: 768, height: 786 },
      { width: 390, height: 786 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(partRoute);

      const preview = page.getByRole("region", { name: "Part preview" });
      const partInformation = page.getByRole("heading", { name: "Part information" });
      const quoteInformation = page.getByRole("region", { name: "Quote information" });
      const quoteCriteria = page.getByRole("group", { name: "Quote preset" });
      const scatterChart = page.getByRole("group", {
        name: "Quote comparison by ready-to-ship working days and quoted total",
      });

      await expect(preview).toBeVisible();
      await expect(partInformation).toBeVisible();
      await expect(quoteInformation).toBeAttached();
      await expect(quoteCriteria).toBeAttached();
      await expect(scatterChart).toBeAttached();
      await expect(page.getByRole("tab", { name: "CAD" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("Manufacturing view", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Activity and history" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      const ordered = await page.evaluate(() => {
        const previewElement = document.querySelector('[aria-label="Part preview"]');
        const partInformationElement = document.querySelector("#part-information-heading");
        const quoteInformationElement = document.querySelector('[aria-label="Quote information"]');
        const quoteCriteriaElement = document.querySelector('[aria-label="Quote preset"]');
        const scatterChartElement = document.querySelector(
          '[aria-label="Quote comparison by ready-to-ship working days and quoted total"]',
        );

        if (
          !previewElement ||
          !partInformationElement ||
          !quoteInformationElement ||
          !quoteCriteriaElement ||
          !scatterChartElement
        ) {
          return false;
        }

        const follows = (earlier: Element, later: Element) =>
          Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

        return (
          follows(previewElement, partInformationElement) &&
          follows(partInformationElement, quoteInformationElement) &&
          follows(quoteInformationElement, quoteCriteriaElement) &&
          follows(quoteCriteriaElement, scatterChartElement)
        );
      });

      expect(ordered).toBe(true);
      await expectNoDocumentOverflow(page);
    }

    for (const viewport of [
      { width: 1512, height: 751 },
      { width: 768, height: 786 },
      { width: 390, height: 786 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");
      const preview = page.getByRole("region", { name: "Part preview" });
      const cadViewport = page.locator('[data-artifact-viewport="cad"]');
      await expectContainedBy(preview, cadViewport);

      const cadVisual = cadViewport.locator('canvas, [aria-label^="CAD preview for"]').first();
      if (await cadVisual.count()) {
        await expectContainedBy(cadViewport, cadVisual);
      }

      await page.getByRole("tab", { name: "Drawing" }).click();
      const drawingViewport = page.locator('[data-artifact-viewport="drawing"]');
      await expectContainedBy(preview, drawingViewport);

      const drawingVisual = drawingViewport.locator("iframe, img").first();
      if (await drawingVisual.count()) {
        await expectContainedBy(drawingViewport, drawingVisual);
      }
    }

    await page.setViewportSize({ width: 390, height: 786 });
    await page.goto(partRoute);
    await page.getByRole("button", { name: "Open inspector" }).click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "390px");
  });

  test("uses sheets at tablet and phone widths without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 786 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    await expect(page.locator('[data-workspace-inspector="desktop"]')).toBeHidden();
    await page.getByRole("button", { name: "Open inspector" }).click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "336px");
    await expectNoDocumentOverflow(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open inspector" })).toBeFocused();
    await page.getByRole("button", { name: "Open inspector" }).click();
    await page.setViewportSize({ width: 1512, height: 786 });
    await expect(page.locator('[data-workspace-inspector="desktop"]')).toBeVisible();
    await page.setViewportSize({ width: 768, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 786 });
    await page.goto("/parts?fixture=client-quoted&debug=1");

    await expect(page.getByRole("complementary")).toBeHidden();
    const navigationTrigger = page.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "224px");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.keyboard.press("Escape");
    await expect(navigationTrigger).toBeFocused();
    await navigationTrigger.click();
    await page.setViewportSize({ width: 768, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
