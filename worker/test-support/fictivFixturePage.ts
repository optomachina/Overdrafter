import { JSDOM } from "jsdom";

/**
 * A stand-in for the Playwright Page the Fictiv adapter drives, backed by a
 * jsdom document so the adapter's real selectors run against a structural
 * fixture instead of per-selector stubs (OVD-1053). It never opens a network
 * connection or a browser.
 *
 * Time is virtual: `waitForTimeout` advances `clock.now` by the requested wait
 * plus `pollOverheadMs` (the locator round trips and body text read each live
 * poll costs), and the test installs `clock.now` as `Date.now`, so the
 * adapter's deadlines run against simulated live timing.
 */
export type FixturePageEvent = { kind: string; detail: string };

export type FixturePageOptions = {
  html: string;
  url?: string;
  clock: { now: number };
  pollOverheadMs?: number;
  /** Shared, ordered log of page actions; tests append kill-switch reads to the same log. */
  events?: FixturePageEvent[];
  /** Runs before the default click behavior; throw to simulate a click Playwright could not complete. */
  onClick?: (element: Element, page: FictivFixturePage) => void;
  onSetInputFiles?: (element: Element, files: unknown, page: FictivFixturePage) => void;
  onTick?: (page: FictivFixturePage) => void;
};

/** A non-opaque origin so jsdom never throws on storage access; nothing is ever fetched from it. */
const FIXTURE_ORIGIN = { url: "https://fixture.invalid/" };

const SKIPPED_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Approximates Playwright's innerText: one line per text node, hidden subtrees and scripts skipped. */
export function fixtureText(element: Element): string {
  const document = element.ownerDocument;
  const walker = document.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
  const lines: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || SKIPPED_TEXT_PARENTS.has(parent.tagName) || parent.closest("[hidden]")) continue;
    const text = (node.textContent ?? "").replaceAll(/\s+/g, " ").trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

/** Playwright's `:has-text("…")` is not CSS; emulate it as a case-insensitive substring filter. */
function queryAll(document: Document, selector: string): Element[] {
  const hasText = /^(.*):has-text\("([^"]*)"\)$/.exec(selector);
  if (hasText) {
    const needle = hasText[2].toLowerCase();
    return queryAll(document, hasText[1] || "*")
      .filter((element) => fixtureText(element).replaceAll("\n", " ").toLowerCase().includes(needle));
  }
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

/** A short, stable name for a clicked element, for the event log. */
export function describeFixtureElement(element: Element): string {
  const processCard = element.closest("label.ant-radio-wrapper[data-fixture-process]");
  if (processCard) return `process-card:${processCard.getAttribute("data-fixture-process")}`;
  const testTarget = element.closest("[data-test-target]")?.getAttribute("data-test-target");
  if (testTarget) return `test-target:${testTarget}`;
  return `${element.tagName.toLowerCase()}:${fixtureText(element).replaceAll("\n", " ").slice(0, 40)}`;
}

/** Clicking anywhere inside an Ant Design radio card's label checks that card, as a browser would. */
function activateRadioCard(element: Element) {
  const card = element.closest("label.ant-radio-wrapper");
  if (!card) return;
  const group = card.closest(".ant-radio-group") ?? card.ownerDocument;
  for (const other of group.querySelectorAll("label.ant-radio-wrapper")) {
    other.classList.toggle("ant-radio-wrapper-checked", other === card);
    other.querySelector(".ant-radio")?.classList.toggle("ant-radio-checked", other === card);
    const input = other.querySelector("input.ant-radio-input");
    if (input) (input as HTMLInputElement).checked = other === card;
  }
}

class FixtureLocator {
  constructor(
    private readonly page: FictivFixturePage,
    private readonly label: string,
    private readonly resolve: () => Element[],
    private readonly narrowed: boolean,
  ) {}

  first() {
    return new FixtureLocator(this.page, `${this.label} >> first`, () => this.resolve().slice(0, 1), true);
  }

  nth(index: number) {
    return new FixtureLocator(this.page, `${this.label} >> nth=${index}`, () => this.resolve().slice(index, index + 1), true);
  }

  filter(options: { hasText?: RegExp }) {
    const hasText = options.hasText;
    if (!hasText) return this;
    return new FixtureLocator(
      this.page,
      `${this.label} >> has-text=${hasText.source}`,
      () => this.resolve().filter((element) => hasText.test(fixtureText(element))),
      this.narrowed,
    );
  }

  async count() {
    return this.resolve().length;
  }

  async isVisible() {
    const element = this.single(false);
    return Boolean(element) && !element?.closest("[hidden]");
  }

  async innerText() {
    return fixtureText(this.single(true)!);
  }

  async getAttribute(name: string) {
    return this.single(true)!.getAttribute(name);
  }

  async waitFor() {
    if (this.resolve().length === 0) throw new Error(`Timeout waiting for ${this.label}`);
  }

  async click() {
    const element = this.single(true)!;
    this.page.record("click", describeFixtureElement(element));
    this.page.options.onClick?.(element, this.page);
    activateRadioCard(element);
  }

  async setInputFiles(files: unknown) {
    const element = this.single(true)!;
    if (element.tagName !== "INPUT" || element.getAttribute("type") !== "file") {
      throw new Error(`Error: Node is not an HTMLInputElement of type file (${this.label})`);
    }
    const names = (Array.isArray(files) ? files : [files]).map((file) =>
      typeof file === "string" ? file.split("/").at(-1) ?? file : String((file as { name?: string }).name));
    this.page.record("set_input_files", names.join(","));
    this.page.options.onSetInputFiles?.(element, files, this.page);
  }

  async fill(value: string) {
    const element = this.single(true)!;
    this.page.record("fill", value);
    (element as HTMLInputElement).value = value;
  }

  async press(key: string) {
    this.single(true);
    this.page.record("press", key);
  }

  /** Playwright actions are strict: an unnarrowed locator that matches several elements throws. */
  private single(required: boolean) {
    const matches = this.resolve();
    if (!this.narrowed && matches.length > 1) {
      throw new Error(`strict mode violation: ${this.label} resolved to ${matches.length} elements`);
    }
    if (required && matches.length === 0) throw new Error(`Timeout waiting for ${this.label}`);
    return matches[0] ?? null;
  }
}

export class FictivFixturePage {
  private dom: JSDOM;
  private currentUrl: string;
  readonly visitedUrls: string[] = [];
  readonly events: FixturePageEvent[];

  constructor(readonly options: FixturePageOptions) {
    this.dom = new JSDOM(options.html, FIXTURE_ORIGIN);
    this.currentUrl = options.url ?? "about:blank";
    this.events = options.events ?? [];
  }

  get document() {
    return this.dom.window.document;
  }

  record(kind: string, detail: string) {
    this.events.push({ kind, detail });
  }

  /** Swap the whole document, as a client-side route change does. */
  render(html: string, url?: string) {
    this.dom = new JSDOM(html, FIXTURE_ORIGIN);
    if (url) this.currentUrl = url;
  }

  /** Clone one of the fixture's `<template data-fixture-template="…">` blocks into `target`. */
  showTemplate(name: string, target: Element) {
    const template = this.document.querySelector(`template[data-fixture-template="${name}"]`) as HTMLTemplateElement | null;
    if (!template) throw new Error(`fixture template ${name} is missing`);
    target.replaceChildren(template.content.cloneNode(true));
  }

  url() {
    return this.currentUrl;
  }

  async goto(url: string) {
    this.visitedUrls.push(url);
    this.record("goto", url);
    this.currentUrl = url;
    return null;
  }

  async content() {
    return `<!DOCTYPE html>${this.document.documentElement.outerHTML}`;
  }

  locator(selector: string) {
    return new FixtureLocator(this, selector, () => queryAll(this.document, selector), false);
  }

  getByRole(role: string, input: { name?: RegExp } = {}) {
    return new FixtureLocator(
      this,
      `role=${role}`,
      () => queryAll(this.document, `[role="${role}"]`)
        .filter((element) => !input.name || input.name.test(fixtureText(element))),
      false,
    );
  }

  async waitForTimeout(ms: number) {
    this.options.clock.now += ms + (this.options.pollOverheadMs ?? 0);
    this.options.onTick?.(this);
  }

  async waitForLoadState() {
    return undefined;
  }
}
