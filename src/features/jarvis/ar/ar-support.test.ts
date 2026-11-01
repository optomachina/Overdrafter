import { describe, expect, it } from "vitest";
import { detectAr, isHttps } from "./ar-support";

import { model, ios, android, desktop } from "./ar-fixtures";

describe("AR platform adapter", () => {
  it("selects Quick Look on iOS and touch iPadOS", () => {
    for (const device of [ios, { ...ios, userAgent: "Macintosh Safari" }]) {
      expect(detectAr(model, device)).toEqual({ state: "available", mode: "quick-look", href: model.usdzUrl });
    }
  });
  it("encodes the exact Scene Viewer intent including signed query, title and fallback", () => {
    expect(detectAr(model, android)).toEqual({ state: "available", mode: "scene-viewer", href: "intent://arvr.google.com/scene-viewer/1.0?file=https%3A%2F%2Ffiles.example%2Fplate.glb%3Fsig%3Da%2Bb%26v%3D1&mode=ar_preferred&title=Plate%20%26%20review#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=https%3A%2F%2Fapp.example%2Fmodel%3Fid%3D1%26view%3D3d;end;" });
  });
  it("prioritizes Safari fallback inside the installed iOS app", () => {
    expect(detectAr(model, { ...ios, standalone: true })).toEqual({ state: "ar-safari", href: model.viewUrl });
  });
  it("hides AR on desktop, missing USDZ, unsupported rel and non HTTPS GLB", () => {
    for (const [input, device] of [[model, desktop], [{ ...model, usdzUrl: undefined }, ios], [model, { ...ios, supportsAr: false }], [{ ...model, glbUrl: "http://files.example/plate.glb" }, android], [{ ...model, glbUrl: undefined }, android]] as const) {
      expect(detectAr(input, device)).toEqual({ state: "unavailable" });
    }
  });
});

it.each([undefined, "", "invalid", "javascript:alert(1)", "http://files.example/model"])("rejects unsafe or missing URLs: %s", (url) => {
  expect(isHttps(url)).toBe(false);
  expect(detectAr({ ...model, usdzUrl: url }, ios)).toEqual({ state: "unavailable" });
  expect(detectAr({ ...model, usdzUrl: url }, { ...ios, standalone: true })).toEqual({ state: "unavailable" });
  expect(detectAr({ ...model, viewUrl: url! }, { ...ios, standalone: true })).toEqual({ state: "unavailable" });
  expect(detectAr({ ...model, viewUrl: url! }, android)).toEqual({ state: "unavailable" });
  expect(detectAr({ ...model, glbUrl: url }, android)).toEqual({ state: "unavailable" });
});

it.each(["http://localhost:4173/plate.glb", "http://127.0.0.1:4173/plate.glb"])("treats loopback http as a secure context: %s", (url) => {
  expect(isHttps(url)).toBe(true);
});
