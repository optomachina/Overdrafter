import type { Frame, Page, Request, Route } from "playwright";
import { hashJson } from "./projection.js";
import { snapshotExpression, type SnapshotCall } from "./snapshot.js";
import type { BoundaryViolation, DriverSurface, LiveTarget, RawElement, RawObservation } from "./types.js";

/**
 * Playwright implementation of the driver surface. Executes only what the
 * loop has already validated: mouse input at a hit-tested centre, keyboard
 * input of a code-supplied value, or an in-page native select. Installs the
 * driver-window boundary guards (§12): mutating requests to checkout-like
 * paths are aborted, popups are closed, file choosers are intercepted, and
 * main-frame navigation off the allowed route is recorded. Every one of them
 * stops the run.
 */
export const DRIVER_ACTION_TIMEOUT_MS = 3_000;
const CHECKOUT_PATH = /checkout|\/orders?\b|payment|\/cart\b/i;
const MAX_RAW_ELEMENTS = 300;

export type PlaywrightSurfaceOptions = {
  vocabulary: readonly string[];
  excludeSelectors: readonly string[];
  /** Frames beyond the main frame are observed only when their origin is allowed. */
  frameAllowed: (url: string) => boolean;
  routeAllowed: (url: string) => boolean;
  actionTimeoutMs?: number;
};

type FrameEntry = { frame: Frame; index: number };
type RawFrameSnapshot = Omit<RawObservation, "elements" | "formState" | "foreignFrames"> & {
  elements: Array<Omit<RawElement, "id"> & { id: number }>;
  formState: Record<string, string>;
};
type RawInspect = { connected: false } | {
  connected: true; actionable: boolean; point: { x: number; y: number } | null; pageKey: string; guard: string; denyText: string;
  excluded: boolean; isLink: boolean;
};

function parseId(id: string) {
  const match = /^f(\d{1,2})_e(\d{1,9})$/.exec(id);
  return match ? { frame: Number(match[1]), node: Number(match[2]) } : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("driver_action_timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function createPlaywrightSurface(page: Page, options: PlaywrightSurfaceOptions): DriverSurface & { dispose(): Promise<void> } {
  let violation: BoundaryViolation | null = null;
  let frames: FrameEntry[] = [];
  const actionMs = options.actionTimeoutMs ?? DRIVER_ACTION_TIMEOUT_MS;
  const record = (kind: BoundaryViolation) => { violation ??= kind; };
  const routeMatcher = (url: URL) => CHECKOUT_PATH.test(url.pathname);
  const routeHandler = async (route: Route, request: Request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.fallback();
    record("network");
    await route.abort("blockedbyclient").catch(() => undefined);
  };
  const onPopup = (popup: Page) => { record("popup"); void popup.close().catch(() => undefined); };
  const onFileChooser = () => record("file_chooser");
  const onNavigated = (frame: Frame) => { if (frame === page.mainFrame() && !options.routeAllowed(frame.url())) record("navigation"); };
  const installed = page.route(routeMatcher, routeHandler);
  page.on("popup", onPopup);
  page.on("filechooser", onFileChooser);
  page.on("framenavigated", onNavigated);

  const evaluate = <T>(frame: Frame, call: SnapshotCall) => frame.evaluate(snapshotExpression(call)) as Promise<T>;
  const allowedFrames = () => {
    const main = page.mainFrame();
    const children = page.frames().filter((frame) => frame !== main);
    const allowed = children.filter((frame) => frame.parentFrame() === main && options.frameAllowed(frame.url()));
    return { entries: [main, ...allowed].map((frame, index) => ({ frame, index })), foreign: children.length - allowed.length };
  };
  const entryFor = (id: string) => {
    const parsed = parseId(id);
    const entry = parsed ? frames.find((candidate) => candidate.index === parsed.frame) : undefined;
    return parsed && entry ? { ...entry, node: parsed.node } : null;
  };
  const frameOffset = async (entry: FrameEntry) => {
    if (entry.index === 0) return { x: 0, y: 0, ok: true };
    const element = await entry.frame.frameElement();
    const box = await element.boundingBox();
    return box ? { x: box.x, y: box.y, ok: true } : { x: 0, y: 0, ok: false };
  };
  const combinedPageKey = async () => hashJson(await Promise.all(frames.map((entry) => evaluate<string>(entry.frame, { op: "pagekey" }))));

  const surface = {
    async observe(): Promise<RawObservation> {
      await installed;
      const { entries, foreign } = allowedFrames();
      frames = entries;
      const snapshots = await Promise.all(entries.map(async (entry) => ({
        entry,
        snapshot: await evaluate<RawFrameSnapshot | null>(entry.frame, {
          op: "snapshot", vocabulary: options.vocabulary, excludeSelectors: options.excludeSelectors, maxElements: MAX_RAW_ELEMENTS,
        }).catch(() => null),
      })));
      const main = snapshots[0]?.snapshot;
      if (!main) throw new Error("driver_observation_unavailable");
      const prefix = (index: number, id: number | string) => `f${index}_e${id}`;
      const elements: RawElement[] = [];
      const formState: Record<string, string> = {};
      const dialogs: RawObservation["dialogs"] = [];
      for (const { entry, snapshot } of snapshots) {
        if (!snapshot) continue;
        for (const element of snapshot.elements) elements.push({ ...element, id: prefix(entry.index, element.id) });
        for (const [key, value] of Object.entries(snapshot.formState)) formState[prefix(entry.index, key)] = value;
        for (const dialog of snapshot.dialogs) dialogs.push({ text: dialog.text, elementIds: dialog.elementIds.map((id) => prefix(entry.index, id)) });
      }
      return {
        url: page.url(),
        pageKey: hashJson(snapshots.map(({ snapshot }) => snapshot?.pageKey ?? null)),
        marker: hashJson(snapshots.map(({ snapshot }) => snapshot?.marker ?? null)),
        elements, dialogs, formState,
        bodyText: snapshots.map(({ snapshot }) => snapshot?.bodyText ?? "").join("\n"),
        foreignFrames: foreign,
        unsupported: snapshots.reduce((sum, { snapshot }) => sum + (snapshot?.unsupported ?? 0), 0),
        truncated: snapshots.some(({ snapshot }) => snapshot?.truncated),
      };
    },

    async inspect(id: string, inspectOptions: { scroll: boolean; forFill: boolean }): Promise<LiveTarget | null> {
      const entry = entryFor(id);
      if (!entry) return null;
      const live = await evaluate<RawInspect>(entry.frame, { op: "inspect", node: entry.node, scroll: inspectOptions.scroll, forFill: inspectOptions.forFill })
        .catch(() => ({ connected: false }) as const);
      if (!live.connected) return { id, pageKey: "", marker: "", guard: "", connected: false, actionable: false, point: null, denyText: "" };
      const offset = await frameOffset(entry);
      let point = live.point && offset.ok ? { x: live.point.x + offset.x, y: live.point.y + offset.y } : null;
      if (point && entry.index !== 0) {
        const frameElement = await entry.frame.frameElement();
        const hitsFrame = await frameElement.evaluate((element, at) => element.ownerDocument?.elementFromPoint(at.x, at.y) === element, point).catch(() => false);
        if (!hitsFrame) point = null;
      }
      const marker = inspectOptions.forFill ? (await surface.observe()).marker : "";
      return {
        id, connected: true, actionable: live.actionable && !live.excluded && !live.isLink, point,
        pageKey: await combinedPageKey(), marker, guard: live.guard, denyText: live.denyText,
      };
    },

    async click(target: LiveTarget) {
      if (!target.point) throw new Error("driver_target_not_hit");
      await withTimeout(page.mouse.click(target.point.x, target.point.y), actionMs);
    },

    async fill(target: LiveTarget, value: string) {
      if (!target.point) throw new Error("driver_target_not_hit");
      await withTimeout((async () => {
        await page.mouse.click(target.point!.x, target.point!.y);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.insertText(value);
      })(), actionMs);
    },

    async pressEnter() {
      await withTimeout(page.keyboard.press("Enter"), actionMs);
    },

    async selectNative(target: LiveTarget) {
      const entry = entryFor(target.id);
      if (!entry) throw new Error("driver_target_missing");
      const selected = await withTimeout(evaluate<boolean>(entry.frame, { op: "select_native", node: entry.node }), actionMs);
      if (!selected) throw new Error("driver_select_unconfirmed");
    },

    async settle(kind: "action" | "combobox_fill", targetId: string | null) {
      const entry = targetId ? entryFor(targetId) : null;
      await evaluate(entry?.frame ?? page.mainFrame(), { op: "settle", kind, node: entry?.node ?? null }).catch(() => undefined);
    },

    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    boundaryViolation: () => violation,

    async locatorCandidates(id: string) {
      const entry = entryFor(id);
      if (!entry) return [];
      const raw = await evaluate<string[]>(entry.frame, { op: "candidates", node: entry.node, vocabulary: options.vocabulary }).catch(() => []);
      const verified: string[] = [];
      for (const selector of raw.slice(0, 8)) {
        const locator = entry.frame.locator(selector);
        const unique = await locator.count().then((count) => count === 1).catch(() => false);
        if (!unique || !(await locator.isVisible().catch(() => false))) continue;
        const same = await locator.evaluate((element, node) =>
          (window as unknown as { __ovdDriver?: { nodes: Map<number, Element> } }).__ovdDriver?.nodes.get(node) === element, entry.node).catch(() => false);
        if (same) verified.push(selector);
      }
      return verified;
    },

    async skeleton(id: string) {
      const entry = entryFor(id);
      if (!entry) return null;
      return evaluate<string | null>(entry.frame, { op: "skeleton", node: entry.node, vocabulary: options.vocabulary }).catch(() => null);
    },

    async dispose() {
      page.off("popup", onPopup);
      page.off("filechooser", onFileChooser);
      page.off("framenavigated", onNavigated);
      await page.unroute(routeMatcher, routeHandler).catch(() => undefined);
    },
  };
  return surface;
}
