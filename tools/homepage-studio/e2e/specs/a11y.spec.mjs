// G. Accessibility: keyboard-only walks, accessible names, tap targets, and contrast (computed styles, formula in
// helpers/color.mjs). No accessibility library is used.
import { test, expect } from "../helpers/fixtures.mjs";
import { contrastReport } from "../helpers/color.mjs";
import { VIEWPORTS, TABLET, PHONE } from "../helpers/viewports.mjs";

const MIN_TARGET = 44; // measured boxes are rounded by the browser: 0.5px tolerance
const MIN_CONTRAST = 4.5;

/** Browser-side accessible name (aria-label, aria-labelledby, visible text, alt, title as last resort). */
function accessibleName(el) {
  const byId = (ids) => ids.split(/\s+/).map((i) => (el.getRootNode().getElementById?.(i) || document.getElementById(i))?.textContent?.trim() || "").join(" ").trim();
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
  if (el.getAttribute("aria-labelledby")) return byId(el.getAttribute("aria-labelledby"));
  if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent.trim()).join(" ");
  const text = (el.innerText || "").trim();
  if (text) return text;
  const img = el.querySelector("img[alt]");
  if (img && img.alt) return img.alt;
  return (el.getAttribute("title") || "").trim();
}

async function unnamed(locator) {
  const out = [];
  const n = await locator.count();
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (!(await el.isVisible())) continue;
    const name = await el.evaluate(accessibleName);
    if (!name) out.push(await el.evaluate((e) => e.outerHTML.slice(0, 100)));
  }
  return out;
}

test.describe("keyboard-only walks (desktop)", { tag: ["@a11y"] }, () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("Tab reaches every top-bar control in a sensible order", async ({ sp, page }) => {
    await sp.open();
    await page.locator("body").focus();
    const seen = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      seen.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className || document.activeElement.tagName));
    }
    const order = ["baseline", "tool", "engine", "outlineLink", "interact", "theme", "historyBtn"];
    let at = -1;
    for (const id of order) {
      const idx = seen.indexOf(id, at + 1);
      expect(idx, `${id} reached by Tab after the previous control (saw ${seen.join(" > ")})`).toBeGreaterThan(at);
      at = idx;
    }
  });

  test("the text edit toolbar works from the keyboard alone: Enter starts, Esc cancels, Enter saves", async ({ sp, page }) => {
    await sp.open();
    const el = sp.fieldEl("hero-cta-primary");
    await el.focus();
    await page.keyboard.press("Enter"); // activates the focused link: the editor turns it into an edit
    await expect(sp.frame.locator('[data-od-editing="1"]')).toBeVisible();
    const toolbar = sp.frame.getByRole("toolbar", { name: "Edit text" });
    await expect(toolbar).toBeVisible();
    await expect(sp.frame.getByRole("textbox", { name: /^Editing / })).toBeFocused();
    for (const name of ["Save", "Cancel", "Copy history", "Regenerate copy"]) await expect(toolbar.getByRole("button", { name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sp.frame.locator('[data-od-editing="1"]')).toHaveCount(0);
    // Again, this time type and save with Enter.
    await el.focus();
    await page.keyboard.press("Enter");
    await expect(sp.frame.getByRole("textbox", { name: /^Editing / })).toBeFocused();
    await sp.replaceText("Start a free account");
    await expect(sp.saveBtn).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(sp.frame.locator('[data-od-editing="1"]')).toHaveCount(0);
    expect((await sp.field("hero-cta-primary")).versions.at(-1).text).toBe("Start a free account");
  });

  test("Tab order is editable -> toolbar buttons -> back to the editable; Shift+Tab reverses; Esc in the toolbar cancels", async ({ sp, page }) => {
    await sp.open();
    await sp.startEdit("hero-eyebrow");
    const active = () => sp.frame.locator("body").evaluate(() => {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a.getAttribute("aria-label") || a.textContent.trim() || a.tagName;
    });
    // Unchanged text: Save is disabled, so the first stop is Cancel.
    for (const name of ["Cancel", "Copy history", "Regenerate copy", "Editing Eyebrow"]) {
      await page.keyboard.press("Tab");
      expect(await active(), `Tab lands on ${name}`).toMatch(new RegExp(`^${name}`));
    }
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await active()).toMatch(/^Editing /);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(sp.frame.locator('[data-od-editing="1"]')).toHaveCount(0);
  });

  test("the History sheet opens from the keyboard, Esc closes it and focus returns to the History button", async ({ sp, page }) => {
    await sp.open();
    await page.locator("#historyBtn").focus();
    await page.keyboard.press("Enter");
    await expect(sp.sheet).toBeVisible();
    await expect(page.locator("#sheetClose")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sp.sheet).toBeHidden();
    await expect(page.locator("#historyBtn")).toBeFocused();
  });

  test("copy history rows are operable by keyboard: Diff and Restore", async ({ sp, page }) => {
    await sp.open();
    await sp.post("/api/copy/ch3-headline/save", { text: "Agents read drawings and quote" });
    await page.reload();
    await sp.waitReady();
    await sp.startEdit("ch3-headline");
    await sp.frame.getByRole("button", { name: "Copy history" }).press("Enter");
    const items = sp.copyTimelineItems();
    await expect(items).toHaveCount(2);
    await items.last().getByRole("button", { name: "Diff vs editor" }).press("Enter");
    await expect(items.last().locator(".diff")).toBeVisible();
    await items.last().getByRole("button", { name: "Restore" }).press("Space");
    await expect(sp.copyTimelineItems()).toHaveCount(3);
  });
});

for (const vp of [TABLET, PHONE]) {
  test.describe(`bottom sheet, ${vp.name}`, { tag: ["@a11y"] }, () => {
    test.use({ viewport: vp.viewport, hasTouch: true });

    // KNOWN GAP found by this suite: the sheet declares aria-modal="true" but has no focus trap, so Tab leaves it after its last control.
    test("the sheet is a modal dialog: Esc closes it, focus returns, Tab and Shift+Tab never leave it", async ({ sp, page }) => {
      await sp.open();
      await page.locator("#historyBtn").focus();
      await page.keyboard.press("Enter");
      await expect(sp.sheet).toBeVisible();
      await expect(sp.sheet).toHaveAttribute("aria-modal", "true");
      await expect(sp.sheet).toHaveAttribute("role", "dialog");
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => !!document.activeElement.closest("#sheet"));
        expect(inside, `Tab ${i + 1} stays inside the modal sheet`).toBe(true);
      }
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#sheet")), "Shift+Tab from the first control wraps inside the sheet").toBe(true);
      await page.keyboard.press("Escape");
      await expect(sp.sheet).toBeHidden();
      await expect(page.locator("#historyBtn")).toBeFocused();
    });
  });
}

for (const vp of [TABLET, PHONE]) {
  test.describe(`bottom sheet keyboard, ${vp.name}`, { tag: ["@a11y"] }, () => {
    test.use({ viewport: vp.viewport, hasTouch: true });
    test("the sheet is a labelled dialog that takes focus; Esc closes it and focus returns to History", async ({ sp, page }) => {
      await sp.open();
      await page.locator("#historyBtn").focus();
      await page.keyboard.press("Enter");
      await expect(sp.sheet).toBeVisible();
      await expect(sp.sheet).toHaveAttribute("role", "dialog");
      await expect(sp.sheet).toHaveAttribute("aria-modal", "true");
      await expect(sp.sheet).toHaveAttribute("aria-labelledby", "sheetTitle");
      await expect(page.locator("#sheetClose")).toBeFocused();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#sheet"))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(sp.sheet).toBeHidden();
      await expect(page.locator("#historyBtn")).toBeFocused();
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`names and targets, ${vp.name}`, { tag: ["@a11y"] }, () => {
    test.use({ viewport: vp.viewport, hasTouch: vp.touch });

    test("every control in the studio chrome and the injected overlay has an accessible name", async ({ sp, page }) => {
      await sp.open();
      await sp.openSettings();
      expect(await unnamed(page.locator("#bar button, #bar a, #bar select, #bar input"))).toEqual([]);
      await sp.closeSettings();
      expect(await unnamed(sp.frame.getByRole("button"))).toEqual([]); // hint and figure icons (shadow DOM)
      await sp.startEdit("hero-eyebrow", { tap: vp.touch });
      expect(await unnamed(sp.frame.getByRole("toolbar").getByRole("button"))).toEqual([]);
      await sp.cancelBtn.click();
      await sp.openHistory();
      expect(await unnamed(page.locator("#sheet button, #sheet a, #sheet textarea, #sheet input, #sheet select"))).toEqual([]);
    });

    if (vp.name !== "desktop 1024x768") {
      test("studio chrome and overlay icons are at least 44x44 CSS px", async ({ sp, page }) => {
        await sp.open();
        await sp.openSettings();
        const small = [];
        const check = async (locator, label) => {
          const n = await locator.count();
          for (let i = 0; i < n; i++) {
            const el = locator.nth(i);
            if (!(await el.isVisible())) continue;
            const box = await el.boundingBox();
            if (box.height < MIN_TARGET - 0.5 || box.width < MIN_TARGET - 0.5) small.push(`${label} ${(await el.evaluate((e) => e.id || e.textContent.trim().slice(0, 20)))} ${Math.round(box.width)}x${Math.round(box.height)}`);
          }
        };
        await check(page.locator("#bar button, #bar a, #bar select"), "bar");
        await sp.closeSettings();
        await check(sp.frame.getByRole("button"), "overlay");
        await sp.startEdit("hero-eyebrow", { tap: true });
        await check(sp.frame.getByRole("toolbar").getByRole("button"), "toolbar");
        await sp.cancelBtn.click();
        await sp.openHistory();
        await check(page.locator("#sheet button, #sheet a"), "sheet");
        expect(small, "controls smaller than 44x44").toEqual([]);
      });
    }
  });
}

test.describe("contrast >= 4.5:1 (computed styles)", { tag: ["@a11y"] }, () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  for (const theme of ["dark", "light"]) {
    test(`studio chrome text, ${theme} theme`, async ({ sp, page }) => {
      await sp.open();
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.locator("#theme").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await sp.startEdit("hero-eyebrow");
      await sp.replaceText("Agents arrive next year"); // an error message on screen
      await expect(sp.msg.locator(".e")).toBeVisible();
      const sheetOpen = page.locator("#historyBtn");
      await sheetOpen.click();
      const groups = {
        bar: page.locator("#bar .brand-t, #bar label, #bar .btn, #bar select, #saveText"),
        sheet: page.locator("#sheet h2, #sheet h3, #sheet .meta, #sheet .btn, #sheet p"),
        toolbar: sp.frame.locator(".lab, .msg .e, button"),
      };
      const low = [];
      for (const [name, loc] of Object.entries(groups)) {
        for (const r of await contrastReport(loc)) if (r.ratio < MIN_CONTRAST) low.push(`${theme} ${name} "${r.text}" ${r.ratio.toFixed(2)} (${r.fg} on ${r.bg})`);
      }
      expect(low, "text below 4.5:1").toEqual([]);
    });
  }

  for (const scheme of ["dark", "light"]) {
    test(`v9 prompt bar, roadmap and Coming soon panel, ${scheme} theme`, async ({ page, site }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${site.url}/v9/`);
      await expect(page.locator("html")).not.toHaveAttribute("data-theme", scheme === "dark" ? "light" : "dark");
      const pbar = page.locator("#pbarHost");
      await pbar.scrollIntoViewIfNeeded();
      await expect(page.locator(".pwrap .pt").first()).not.toBeEmpty();
      const heads = page.locator(".cl-head").first();
      await heads.scrollIntoViewIfNeeded();
      await heads.click();
      const low = [];
      const groups = {
        prompt: page.locator(".pwrap .pl, .pwrap .pagent, .pwrap .pt, .pwrap .ps-live, .pwrap .ps-soon, .pwrap .pn, .pwrap .pchip .pc-t, .pwrap .pchip .pc-s"),
        wires: page.locator(".cap .st, .cap .lb, .capcap, .cl-head .st, .cl-head .lb, .chip .st, .chip .lb"),
        roadmap: page.locator("#roadmap .bandtag, #roadmap h2, #roadmap .sent, .final .closing"),
      };
      for (const [name, loc] of Object.entries(groups)) {
        for (const r of await contrastReport(loc, { limit: 40 })) if (r.ratio < MIN_CONTRAST) low.push(`${scheme} ${name} "${r.text}" ${r.ratio.toFixed(2)} (${r.fg} on ${r.bg})`);
      }
      // The Coming soon panel.
      const node = page.locator('.cap[data-cap="text2cad"] button.node').first();
      await node.scrollIntoViewIfNeeded();
      await node.click();
      await expect(page.locator("#soon")).toBeVisible();
      await page.locator("#soonEmail").fill("bad");
      await page.locator('#soonForm button[type="submit"]').click();
      await expect(page.locator("#soonErr")).toBeVisible();
      const panel = page.locator("#soon .kick, #soon h2, #soon .st, #soon .lb, #soon .lab, #soon .ptext, #soon label, #soon .consent, #soon .err, #soon .btn:not(.primary), #soon input");
      for (const r of await contrastReport(panel, { limit: 40 })) if (r.ratio < MIN_CONTRAST) low.push(`${scheme} panel "${r.text}" ${r.ratio.toFixed(2)} (${r.fg} on ${r.bg})`);
      expect(low, "text below 4.5:1").toEqual([]);
    });
  }

  // Regression: the primary submit button was white on #d4480f (hover) = 4.44:1.
  for (const scheme of ["dark", "light"]) {
    test(`v9 Coming soon panel: the primary submit button text reaches 4.5:1 at rest and on hover (${scheme})`, async ({ page, site }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${site.url}/v9/`);
      const node = page.locator('.cap[data-cap="text2cad"] button.node').first();
      await node.scrollIntoViewIfNeeded();
      await node.click();
      const btn = page.locator("#soon .btn.primary");
      await page.mouse.move(0, 0);
      const [rest] = await contrastReport(btn);
      expect(rest.ratio, `${scheme} rest`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      await btn.hover();
      const [hover] = await contrastReport(btn);
      expect(hover.ratio, `${scheme} hover`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  }
});
