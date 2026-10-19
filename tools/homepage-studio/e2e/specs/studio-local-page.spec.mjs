// A. Page mode in the local studio: load, controls, hint, in-place editing, copy lint, copy history, regenerate.
import { test, expect } from "../helpers/fixtures.mjs";
import { VIEWPORTS, DESKTOP } from "../helpers/viewports.mjs";
import { TOOLS } from "../helpers/studio-page.mjs";
import { expectAppendOnly } from "../helpers/versions.mjs";

const LOCKUP = ["OverDrafter", "Your agent for", "Building machines"];

for (const vp of VIEWPORTS) {
  test.describe(`Page mode, ${vp.name}`, { tag: ["@studio-local"] }, () => {
    test.use({ viewport: vp.viewport, hasTouch: vp.touch });

    test("loads v9 full width in a sandboxed iframe", async ({ sp, page }) => {
      await sp.open();
      const iframe = page.locator("#pageFrame");
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
      await expect(iframe).toHaveAttribute("src", /\/api\/preview\/baseline\/v9\?theme=/);
      const box = await iframe.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(vp.viewport.width - 2);
      await expect(sp.frame.locator("h1 .l")).toHaveText(["OverDrafter", "Your agent for", "Building hardware"]);
      await expect(page).toHaveTitle("OverDrafter Homepage Studio");
    });

    test("the slim top bar has every control", async ({ sp, page }) => {
      await sp.open();
      await sp.openSettings();
      await expect(page.locator("#baseline")).toBeVisible();
      await expect(page.locator("#tool option")).toHaveCount(TOOLS.length);
      expect(await page.locator("#tool option").evaluateAll((os) => os.map((o) => o.value))).toEqual(TOOLS);
      const engines = await page.locator("#engine option").evaluateAll((os) => os.map((o) => o.value));
      expect(engines).toEqual(expect.arrayContaining(["template-demo", "claude-cli", "github-actions"]));
      await expect(page.locator("#engine")).toHaveValue("template-demo");
      await sp.closeSettings();
      await expect(page.locator("#interact")).toBeVisible();
      await expect(page.locator("#theme")).toBeVisible();
      await expect(page.locator("#historyBtn")).toBeVisible();
      await expect(page.locator("#saveStatus")).toBeVisible();
      await expect(page.locator("#saveStatus")).toHaveText("Saved");
    });

    test("the one-time hint shows once", async ({ sp, page }) => {
      await sp.open();
      const hint = sp.frame.getByText("Tap any text to edit");
      await expect(hint).toBeVisible();
      await sp.startEdit("hero-eyebrow", { tap: vp.touch });
      await expect(hint).toBeHidden();
      await sp.cancelBtn.click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("od-studio-hint-dismissed"))).toBe("1");
      await page.reload();
      await sp.waitReady();
      await expect(sp.frame.getByText("Tap any text to edit")).toBeHidden();
    });

    test("editing the hero headline lockup saves a new version that survives a reload", async ({ sp, page }) => {
      await sp.open();
      const before = await sp.field("hero-headline");
      expect(before.versions).toHaveLength(1);
      await sp.editField("hero-headline", LOCKUP.join("\n"), { tap: vp.touch });
      await sp.saveAndWait();
      const after = await sp.field("hero-headline");
      expect(after.versions).toHaveLength(2);
      expect(after.versions.at(-1)).toMatchObject({ kind: "manual", author: "human", text: LOCKUP.join("\n") });
      expectAppendOnly(before, after);
      await expect(sp.frame.locator("h1 .l")).toHaveText(LOCKUP);
      // The new version shows up in History.
      await sp.openHistory();
      await expect(sp.sheet.getByText("Recent copy changes")).toBeVisible();
      await expect(sp.sheet.locator("li.field", { hasText: "Building machines" })).toBeVisible();
      await sp.closeSheet();
      // Reload: the saved wording is applied again by the editor.
      await page.reload();
      await sp.waitReady();
      await expect(sp.frame.locator("h1 .l")).toHaveText(LOCKUP);
    });
  });
}

test.describe("Page mode editing flows (desktop)", { tag: ["@studio-local"] }, () => {
  test.use({ viewport: DESKTOP.viewport });

  test("a chapter headline and the mission text can be edited and survive a reload", async ({ sp, page }) => {
    await sp.open();
    await sp.editField("ch3-headline", "Agents turn drawings into quotes fast");
    await sp.saveAndWait();
    await sp.editField("mission-text", "Reduce the time to Mars by 10% through creative and efficient deployment of engineering resources.");
    // Unchanged text: Save is not offered, Cancel closes the edit.
    await expect(sp.saveBtn).toBeDisabled();
    await sp.cancelBtn.click();
    await sp.editField("mission-text", "Reduce the time to Mars by 10% through creative and efficient deployment of engineering resources, every day.");
    await sp.saveAndWait();
    expect((await sp.field("ch3-headline")).versions.at(-1).text).toBe("Agents turn drawings into quotes fast");
    expect((await sp.field("mission-text")).versions).toHaveLength(2);
    await page.reload();
    await sp.waitReady();
    await expect(sp.fieldEl("ch3-headline")).toHaveText("Agents turn drawings into quotes fast");
    await expect(sp.fieldEl("mission-text")).toContainText("every day.");
  });

  const BLOCKED = [
    ["a year", "Agents quote parts in 2027", /year "2027"/],
    ["a third-party name", "Agents work inside SolidWorks", /third-party name "SolidWorks"/],
    ["next year", "Agents arrive next year", /"next year"/],
    ["a bare Live label", "Live", /never a bare "Live"/],
  ];
  for (const [name, text, message] of BLOCKED) {
    test(`copy lint blocks ${name} inline and creates no version`, async ({ sp, page }) => {
      await sp.open();
      const before = await sp.field("ch3-headline");
      await sp.editField("ch3-headline", text);
      await expect(sp.msg.locator(".e")).toContainText(message);
      await expect(sp.saveBtn).toBeDisabled();
      await page.keyboard.press("Enter"); // an attempt to save from the keyboard must not get through either
      await expect(sp.msg.locator(".e")).toContainText(message);
      await expect(sp.frame.locator('[data-od-editing="1"]')).toHaveCount(1);
      const after = await sp.field("ch3-headline");
      expect(after.versions).toHaveLength(before.versions.length);
      // The API refuses it too (defense in depth): 422 and still no version.
      const res = await sp.post("/api/copy/ch3-headline/save", { text });
      expect(res.status()).toBe(422);
      expect((await sp.field("ch3-headline")).versions).toHaveLength(before.versions.length);
    });
  }

  test("a 30-word sentence is only a warning and saves after a confirm", async ({ sp }) => {
    await sp.open();
    const long = `${Array.from({ length: 30 }, () => "steady").join(" ")}.`;
    const before = await sp.field("ch3-headline");
    await sp.editField("ch3-headline", long);
    await expect(sp.msg.locator(".w")).toContainText(/30 words/);
    await expect(sp.saveBtn).toHaveText("Save anyway");
    await sp.saveBtn.click(); // first tap only shows the warning
    await expect(sp.msg.locator(".w")).toContainText(/30 words/);
    expect((await sp.field("ch3-headline")).versions).toHaveLength(before.versions.length);
    await sp.saveAndWait(); // second tap confirms
    const after = await sp.field("ch3-headline");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions.at(-1).lint.warnings[0]).toMatch(/30 words/);
  });

  test("copy history: timeline, diff against an older version, Restore adds a NEW version", async ({ sp }) => {
    await sp.open();
    const id = "ch3-headline";
    for (const text of ["Agents read drawings and quote", "Agents turn drawings into priced quotes"]) {
      expect((await sp.post(`/api/copy/${id}/save`, { text })).status()).toBe(200);
    }
    await sp.page.reload();
    await sp.waitReady();
    const before = await sp.field(id);
    expect(before.versions).toHaveLength(3);
    await sp.startEdit(id);
    await sp.frame.getByRole("button", { name: "Copy history" }).click();
    await expect(sp.sheet).toBeVisible();
    await expect(sp.page.locator("#sheetTitle")).toContainText("Copy: Headline");
    const items = sp.copyTimelineItems();
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText("Agents turn drawings into priced quotes");
    await expect(items.first()).toContainText("current");
    // Diff the oldest version against the editor.
    await items.last().getByRole("button", { name: "Diff vs editor" }).click();
    await expect(items.last().locator(".diff")).toBeVisible();
    await expect(items.last().locator(".diff ins, .diff del").first()).toBeVisible();
    // Restore the oldest: a fourth record is appended, the older ones are untouched.
    await items.last().getByRole("button", { name: "Restore" }).click();
    await expect(sp.copyTimelineItems()).toHaveCount(4);
    const after = await sp.field(id);
    expect(after.versions).toHaveLength(4);
    expectAppendOnly(before, after);
    expect(after.versions.at(-1)).toMatchObject({ kind: "restore", text: before.versions[0].text });
    expect(after.currentVersionId).toBe(after.versions.at(-1).id);
    await expect(sp.fieldEl(id)).toHaveText(before.versions[0].text);
  });

  test("regenerate copy with the demo engine (API) adds a version labelled as the demo engine", async ({ sp }) => {
    await sp.open();
    const before = await sp.field("hero-lede");
    const res = await sp.post("/api/generate", { kind: "copy", sectionId: "hero", fieldId: "hero-lede", prompt: "shorter", tool: "hand-built", engine: "template-demo" });
    expect(res.status()).toBeLessThan(300);
    const { job } = await res.json();
    await expect.poll(async () => (await (await sp.get(`/api/jobs/${job.id}`)).json()).job.state, { timeout: 20_000 }).toBe("succeeded");
    const after = await sp.field("hero-lede");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    const v = after.versions.at(-1);
    expect(v).toMatchObject({ kind: "generated", engine: "template-demo", author: "agent" });
    expect(v.note).toContain("demo engine, not generated by a model");
    // The timeline in Page mode shows the label after a reload.
    await sp.page.reload();
    await sp.waitReady();
    await sp.startEdit("hero-lede");
    await sp.frame.getByRole("button", { name: "Copy history" }).click();
    await expect(sp.copyTimelineItems().first()).toContainText("demo engine, not generated by a model");
  });

  // KNOWN PRODUCT BUG found by this suite: ui/page.js startJob() sends {kind:"copy", fieldId, prompt} without
  // sectionId (the Outline view's startJob defaults it), so POST /api/generate answers 400 "Invalid section id".
  test("regenerate copy from the toolbar in Page mode sends the field section id", async ({ sp }) => {
    await sp.open();
    const before = await sp.field("hero-lede");
    await sp.startEdit("hero-lede");
    await sp.frame.getByRole("button", { name: "Regenerate copy" }).click();
    await expect(sp.sheet).toBeVisible();
    await sp.page.locator("#regenInstr").fill("shorter");
    await sp.sheet.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(sp.page.locator("#toast")).toContainText("New copy version saved.", { timeout: 20_000 });
    const after = await sp.field("hero-lede");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions.at(-1).note).toContain("demo engine, not generated by a model");
  });
});
