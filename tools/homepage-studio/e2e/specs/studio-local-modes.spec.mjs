// C. Theme and modes in the local studio: theme toggle, Interact mode, Outline view.
import { test, expect } from "../helpers/fixtures.mjs";
import { DESKTOP } from "../helpers/viewports.mjs";
import { luminance, parseColor } from "../helpers/color.mjs";

const bgLum = async (locator) => luminance(parseColor(await locator.evaluate((el) => getComputedStyle(el).backgroundColor)));

test.describe("theme and modes (desktop)", { tag: ["@studio-local"] }, () => {
  test.use({ viewport: DESKTOP.viewport, colorScheme: "dark" });

  test("the theme toggle switches studio chrome and the page together and persists across reload", async ({ sp, page }) => {
    await sp.open();
    const html = page.locator("html");
    const pageHtml = sp.frame.locator("html");
    const toggle = page.locator("#theme");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(pageHtml).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const studioDark = await bgLum(page.locator("body"));
    const pageDark = await bgLum(sp.frame.locator("body"));
    await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(pageHtml).toHaveAttribute("data-theme", "light");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#themeLabel")).toHaveText("Light");
    await expect.poll(() => bgLum(page.locator("body"))).toBeGreaterThan(studioDark + 0.3);
    await expect.poll(() => bgLum(sp.frame.locator("body"))).toBeGreaterThan(pageDark + 0.3);
    expect(await page.evaluate(() => localStorage.getItem("od-studio-theme"))).toBe("light");
    // The editor's own overlay icons follow the theme too (their shadow roots are painted from the same palette).
    await expect(sp.historyIcon("Hero")).toBeVisible();
    await page.reload();
    await sp.waitReady();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(pageHtml).toHaveAttribute("data-theme", "light");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(pageHtml).toHaveAttribute("data-theme", "dark");
  });

  test("Interact mode lets the page's own Coming soon panel work: opens, Esc closes, focus returns", async ({ sp, page }) => {
    await sp.open();
    const interact = page.locator("#interact");
    // In edit mode the page's own controls are intercepted: a tap on a coming-soon node edits nothing and opens no panel.
    const node = sp.frame.locator('.cap[data-cap="text2cad"] button.node').first();
    await node.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await node.click();
    await expect(sp.frame.locator("#soonBk")).toBeHidden();
    await interact.click();
    await expect(interact).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#toast")).toContainText("Interact mode");
    await node.click();
    const panel = sp.frame.locator("#soonBk");
    await expect(panel).toBeVisible();
    await expect(sp.frame.locator("#soon")).toBeFocused();
    await expect(sp.frame.locator("#soonT")).toHaveText("Text to CAD");
    await expect(sp.frame.locator("#soonSt")).toContainText("Coming soon");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(node).toBeFocused();
    // Interact off again: editing is back.
    await interact.click();
    await expect(interact).toHaveAttribute("aria-pressed", "false");
  });

  test("Interact mode lets the page's own prompt bar type its example prompt; editing is off while it is on", async ({ sp, page }) => {
    await sp.open();
    await page.locator("#interact").click();
    const prompts = await sp.frame.locator("body").evaluate(() => window.PROMPTS.filter((p) => p.chapter === 1).map((p) => p.text));
    const typed = sp.frame.locator(".pwrap .pt").first();
    await expect(typed).toHaveText(prompts[0], { timeout: 15_000 });
    // A click on text starts no edit in Interact mode.
    await sp.fieldEl("hero-lede").click();
    await expect(sp.frame.locator('[data-od-editing="1"]')).toHaveCount(0);
  });

  test("Outline view still edits a field and the change appears in Page mode", async ({ sp, page }) => {
    await sp.goto("/outline.html");
    await expect(page.locator("h1.brand")).toContainText("Homepage Studio");
    const ta = page.locator("#txt-hero-eyebrow");
    await expect(ta).toBeVisible();
    await ta.fill("One part, idea to shelf, on time");
    const card = page.locator("#copyFields > *").filter({ has: ta });
    await card.getByRole("button", { name: /^Save/ }).click();
    await expect(page.locator("#toast")).toContainText("Saved as a new version.");
    expect((await sp.field("hero-eyebrow")).versions.at(-1).text).toBe("One part, idea to shelf, on time");
    await page.locator("#pageView").click();
    await sp.waitReady();
    await expect(sp.fieldEl("hero-eyebrow")).toHaveText("One part, idea to shelf, on time");
  });
});
