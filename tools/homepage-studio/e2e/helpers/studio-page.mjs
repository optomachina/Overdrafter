// Page object for Homepage Studio Page mode. All waits are expect-polling or event based, never sleeps.
import { expect } from "@playwright/test";

export const TOOLS = ["hand-built", "anatomy", "anatomy-asset", "isoglow", "machine"];

export class StudioPage {
  constructor(page, studio) {
    this.page = page;
    this.studio = studio;
    this.frame = page.frameLocator("#pageFrame");
    this.sheet = page.locator("#sheet");
  }

  /**
   * Same-origin API access that carries the studio's session. Local mode uses the Node-side request context. Hosted mode
   * uses fetch inside the page, because the session cookie is Secure and only the browser sends it over http://127.0.0.1.
   * Returns an object shaped like Playwright's APIResponse (status(), json(), text(), headers()).
   */
  async call(method, path, body, headers = {}) {
    if (this.studio.mode !== "hosted") {
      return this.page.context().request.fetch(`${this.studio.url}${path}`, { method, data: body, headers });
    }
    if (!this.page.url().startsWith(this.studio.url)) await this.page.goto(`${this.studio.url}/api/me`);
    const r = await this.page.evaluate(async ({ method, path, body, headers }) => {
      const res = await fetch(path, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
    }, { method, path, body, headers });
    return { status: () => r.status, text: async () => r.text, json: async () => JSON.parse(r.text), headers: () => r.headers };
  }
  async project() {
    const res = await this.call("GET", "/api/project");
    expect(res.status(), "GET /api/project").toBe(200);
    return res.json();
  }
  async field(id) {
    return (await this.project()).project.fields[id];
  }
  async asset(sectionId) {
    return (await this.project()).project.assets[`asset-${sectionId}`];
  }
  async versionCount(fieldId) {
    return (await this.field(fieldId)).versions.length;
  }
  async post(path, body, headers = {}) {
    return this.call("POST", path, body, headers);
  }
  async get(path) {
    return this.call("GET", path);
  }
  /** Log in through the API from inside the page (hosted mode). */
  async apiLogin(password) {
    const res = await this.post("/api/login", { password });
    expect(res.status(), "POST /api/login").toBe(200);
  }

  async goto(path = "/") {
    await this.page.goto(`${this.studio.url}${path}`);
  }
  /** Open Page mode and wait until the injected editor has initialised and matched the hero headline. */
  async open() {
    await this.goto("/");
    await this.waitReady();
  }
  async waitReady() {
    await expect(this.page.locator("#pageFrame")).toHaveAttribute("src", /\/api\/preview\/baseline\//);
    await expect(this.fieldEl("hero-headline")).toBeAttached({ timeout: 20_000 });
    await expect(this.page.locator("#saveText")).toHaveText("Saved");
  }
  fieldEl(id) {
    return this.frame.locator(`[data-od-field="${id}"]`);
  }

  /** The 390px layout folds the tool, engine and page selectors into a menu behind the Settings button. */
  async openSettings() {
    const btn = this.page.locator("#settingsBtn");
    if (await btn.isVisible()) {
      if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
    }
  }
  async closeSettings() {
    const btn = this.page.locator("#settingsBtn");
    if ((await btn.isVisible()) && (await btn.getAttribute("aria-expanded")) === "true") await btn.click();
  }

  // ---- in-place editing ----
  get saveBtn() {
    return this.frame.locator("button#save");
  }
  get cancelBtn() {
    return this.frame.locator("button#cancel");
  }
  get msg() {
    return this.frame.locator("#msg");
  }
  /** Click (or tap on touch contexts) the field's element inside the sandboxed page. */
  async startEdit(id, { tap = false } = {}) {
    const el = this.fieldEl(id);
    await el.scrollIntoViewIfNeeded();
    if (tap) await el.tap();
    else await el.click();
    await expect(this.frame.locator('[data-od-editing="1"]')).toBeVisible();
    await expect(this.saveBtn).toBeVisible();
  }
  /** Replace the whole text being edited. Lines are separated by "\n" (multi-line fields take Enter). */
  async replaceText(text) {
    await this.page.keyboard.press("ControlOrMeta+a");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.page.keyboard.press("Enter");
      if (lines[i]) await this.page.keyboard.type(lines[i]);
    }
  }
  async editField(id, text, { tap = false } = {}) {
    await this.startEdit(id, { tap });
    await this.replaceText(text);
  }
  /** Wait for the save to finish (toolbar closes, status back to Saved). */
  async saveAndWait() {
    await expect(this.saveBtn).toBeEnabled();
    await this.saveBtn.click();
    await expect(this.frame.locator('[data-od-editing="1"]')).toHaveCount(0);
    await expect(this.page.locator("#saveText")).toHaveText("Saved");
  }

  // ---- sheet (History drawer / bottom sheet) ----
  async openHistory() {
    await this.page.locator("#historyBtn").click();
    await expect(this.sheet).toBeVisible();
    await expect(this.page.locator("#sheetTitle")).toHaveText("History");
  }
  async closeSheet() {
    await this.page.locator("#sheetClose").click();
    await expect(this.sheet).toBeHidden();
  }
  copyTimelineItems() {
    return this.sheet.locator("ol.timeline > li");
  }

  // ---- figures (corner icons live in shadow roots inside the sandboxed page) ----
  historyIcon(label) {
    return this.frame.getByRole("button", { name: new RegExp(`^Version history, ${label}`) });
  }
  sparkleIcon(label) {
    return this.frame.getByRole("button", { name: new RegExp(`^Regenerate figure, ${label}`) });
  }
}
