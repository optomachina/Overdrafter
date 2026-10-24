/**
 * Playwright execution for the Jev quote driver (docs/jev-quote-driver.md §11).
 * Code owns every coordinate and keystroke: the model only names an id from a
 * code-built table. Before input, the live node is rechecked in the page
 * (connected, visible, enabled, not denied, hit-tested at its centre).
 */
import type { Frame, Page } from "playwright";
import { OBSERVER_SOURCE, type FrameObservation, type PrepareResult } from "./snapshot.js";

export type ObserverArgs = { deny: string; maxRecords: number; offerContainers: readonly string[] };

export async function observeFrame(frame: Frame, args: ObserverArgs): Promise<FrameObservation | null> {
  return frame.evaluate(`(${OBSERVER_SOURCE})(${JSON.stringify(args)})`) as Promise<FrameObservation | null>;
}

export type PreparedTarget =
  | { ok: true; x: number; y: number; guard: unknown; pageKey: unknown[] }
  | { ok: false; reason: Extract<PrepareResult, { ok: false }>["reason"] | "frame_occluded" | "evaluate_failed" };

/** In-page recheck and hit test; returns main-frame coordinates. */
export async function prepareTarget(page: Page, frame: Frame, node: number, opts: { fill?: boolean } = {}): Promise<PreparedTarget> {
  let result: PrepareResult;
  try {
    result = await frame.evaluate(`window.__ovdDriver.prepare(${Number(node)}, ${JSON.stringify(opts)})`) as PrepareResult;
  } catch {
    return { ok: false, reason: "evaluate_failed" };
  }
  if (!result.ok) return result;
  if (frame === page.mainFrame()) return result;
  const element = await frame.frameElement().catch(() => null);
  const box = element ? await element.boundingBox().catch(() => null) : null;
  if (!element || !box) return { ok: false, reason: "frame_occluded" };
  const x = box.x + result.x;
  const y = box.y + result.y;
  const unobstructed = await element.evaluate((iframe, point) => iframe.ownerDocument?.elementFromPoint(point.x, point.y) === iframe, { x, y })
    .catch(() => false);
  if (!unobstructed) return { ok: false, reason: "frame_occluded" };
  return { ...result, x, y };
}

export async function settleTarget(frame: Frame, node: number, combobox: boolean) {
  const started = performance.now();
  await frame.evaluate(`window.__ovdDriver.settle(${Number(node)}, ${combobox ? "true" : "false"})`).catch(() => undefined);
  return Math.round(performance.now() - started);
}

export async function readPageKey(frame: Frame): Promise<unknown[] | null> {
  return frame.evaluate("window.__ovdDriver && window.__ovdDriver.pageKey ? window.__ovdDriver.pageKey() : null")
    .then((value) => value as unknown[] | null).catch(() => null);
}

export async function clickAt(page: Page, x: number, y: number) {
  await page.mouse.click(x, y);
}

/** Replaces the focused control's contents with a code-supplied value. */
export async function typeValue(page: Page, x: number, y: number, value: string) {
  await page.mouse.click(x, y);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(value);
}

type KeyEntry = [number, unknown, unknown, unknown, unknown, unknown];

/** Control identities whose value/checked/selection changed within one document. */
export function changedControls(before: unknown[], after: unknown[]) {
  if (before[0] !== after[0]) return { sameDocument: false, changed: [] as number[] };
  const prior = new Map((before[6] as KeyEntry[]).map((entry) => [entry[0], JSON.stringify(entry.slice(1, 4))]));
  const changed: number[] = [];
  for (const entry of after[6] as KeyEntry[]) {
    const previous = prior.get(entry[0]);
    if (previous !== undefined && previous !== JSON.stringify(entry.slice(1, 4))) changed.push(entry[0]);
  }
  return { sameDocument: true, changed };
}
