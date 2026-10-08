import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

const CLIENT_ROUTES = [
  "/parts?fixture=client-quoted&debug=1",
  "/quotes?fixture=client-quoted&debug=1",
  "/search?fixture=client-quoted&debug=1",
  "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1",
  "/quotes/Z5QF44?fixture=client-published&debug=1",
] as const;

// `page.goto` resolves on the document load event, but `src/main.tsx` lazy-imports
// the whole app entry behind an "Opening OverDrafter…" fallback, so the client
// shell mounts later (hundreds of module requests on the fixture dev server).
// Wait for that mount as a readiness state, bounded by the test timeout, so each
// 5 s assertion below measures shell behavior rather than app-entry boot.
async function openClientRoute(page: Page, route: string) {
  await page.goto(route);
  await page.locator("[data-client-shell]").waitFor();
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    windowScrollY: window.scrollY,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.windowScrollY).toBe(0);
}

// Menus become visible while their open animation is still running, so poll the
// hit test until the overlay settles instead of sampling one animation frame.
async function expectOverlayOwnsItsCenter(overlay: Locator) {
  await expect
    .poll(() =>
      overlay.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return topElement === element || element.contains(topElement);
      }),
    )
    .toBe(true);
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
  expect(contentBounds!.height).toBeGreaterThan(0);
  expect(contentBounds!.width).toBeGreaterThan(0);
  expect(contentBounds!.x).toBeGreaterThanOrEqual(containerBounds!.x);
  expect(contentBounds!.y).toBeGreaterThanOrEqual(containerBounds!.y);
  expect(contentBounds!.x + contentBounds!.width).toBeLessThanOrEqual(
    containerBounds!.x + containerBounds!.width,
  );
  expect(contentBounds!.y + contentBounds!.height).toBeLessThanOrEqual(
    containerBounds!.y + containerBounds!.height,
  );
}

test.describe("authenticated client shell contract", { tag: "@fixture" }, () => {
  test("keeps one application frame across every launch client route", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });

    for (const route of CLIENT_ROUTES) {
      await openClientRoute(page, route);
      await expect(page.locator("[data-client-shell]")).toBeVisible();
      await expect(page.getByRole("banner")).toHaveCount(1);
      await expect(page.locator('[data-workspace-scroll="primary"]')).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(1);
      await expectNoDocumentOverflow(page);
    }
  });

  test("exits fixture mode without leaving fixture controls over the live app", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await openClientRoute(page, "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

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
    await openClientRoute(page, "/parts?fixture=client-quoted&debug=1");

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
    // The width transition can wait seconds for its first frame on a loaded host
    // (it holds at currentTime 0 even under reduced motion), so let it settle.
    const sidebar = page.getByRole("complementary");
    await sidebar.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await expect(sidebar).toHaveCSS("width", "52px");

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
    await expectOverlayOwnsItsCenter(menu);
  });

  test("uses one desktop workspace without a detached inspector", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await openClientRoute(page, "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    const workspace = page.locator('[data-workspace-scroll="primary"]');
    await expect(workspace).toBeVisible();
    await expect(page.locator("[data-workspace-inspector]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open inspector" })).toHaveCount(0);

    const workspaceScrollTop = await workspace.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });

    expect(workspaceScrollTop).toBeGreaterThan(0);
    await expect(page.getByRole("banner")).toHaveCSS("height", "56px");
    await expectNoDocumentOverflow(page);
  });

  // These full-page loads have independent contracts and independent timeout budgets.
  for (const [viewportName, viewport] of Object.entries({
    desktop: { width: 1512, height: 751 },
    tablet: { width: 768, height: 786 },
    phone: { width: 390, height: 786 },
  })) {
    test(`keeps the part evidence and quote comparison in a stable ${viewportName} hierarchy`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openClientRoute(page, "/parts/fx-job-published?fixture=client-published&debug=1");

      // Wait for sourcing controls before reading the current scope so a
      // not-yet-rendered toggle is not skipped.
      await expect(page.getByRole("button", { name: /^(US-only sourcing|All sourcing)$/ })).toBeVisible();
      const domesticScope = page.getByRole("button", { name: "US-only sourcing" });
      if (await domesticScope.count()) {
        await domesticScope.click();
      }

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
      if (viewportName === "phone") {
        await expect(page.getByRole("button", { name: "Open inspector" })).toHaveCount(0);
      }
      await expectNoDocumentOverflow(page);
    });

    test(`contains rendered CAD and drawing evidence in the ${viewportName} preview`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openClientRoute(page, "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");
      const preview = page.getByRole("region", { name: "Part preview" });
      const cadViewport = preview.locator('[aria-label^="CAD preview for"]').first();
      await expect(cadViewport).toBeVisible();
      await expectContainedBy(preview, cadViewport);

      // The STEP file is meshed in the browser before the canvas mounts; wait for
      // that render to leave its loading state, bounded by the test timeout.
      await cadViewport.getByText("Generating preview").waitFor({ state: "detached" });
      const cadVisual = cadViewport.locator("canvas");
      await expect(cadVisual).toBeVisible();
      await expectContainedBy(cadViewport, cadVisual);

      await page.getByRole("tab", { name: "Drawing" }).click();
      const drawingViewport = page.locator('[data-artifact-viewport="drawing"]');
      await expect(drawingViewport).toBeVisible();
      await expectContainedBy(preview, drawingViewport);

      const drawingVisual = drawingViewport.locator("iframe, img").first();
      await expect(drawingVisual).toBeVisible();
      await expectContainedBy(drawingViewport, drawingVisual);
    });
  }

  test("uses a phone navigation sheet without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 786 });
    await openClientRoute(page, "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    await expect(page.locator("[data-workspace-inspector]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open inspector" })).toHaveCount(0);
    await expectNoDocumentOverflow(page);

    await page.setViewportSize({ width: 390, height: 786 });
    await openClientRoute(page, "/parts?fixture=client-quoted&debug=1");

    await expect(page.getByRole("complementary")).toBeHidden();
    const navigationTrigger = page.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "224px");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expectNoDocumentOverflow(page);

    // Radix registers the sheet as the topmost dismissable layer in an effect and
    // re-renders before its Escape handler sees that index; until then Escape is
    // ignored. That re-render is what writes the inline pointer-events marker.
    await expect(page.getByRole("dialog")).toHaveAttribute("style", /pointer-events: auto/);
    await page.keyboard.press("Escape");
    await expect(navigationTrigger).toBeFocused();
    await navigationTrigger.click();
    await page.setViewportSize({ width: 768, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
