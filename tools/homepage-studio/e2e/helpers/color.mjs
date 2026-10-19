// WCAG 2.x contrast helpers, evaluated from COMPUTED styles (no dependency).
//
// relative luminance  L = 0.2126 R + 0.7152 G + 0.0722 B, each channel c in [0,1] linearised as
//                      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4
// contrast ratio      (L_lighter + 0.05) / (L_darker + 0.05)
// Text with partial alpha is composited over the nearest opaque ancestor background before measuring.
// Pure functions below run in Node; `contrastProbe` is the browser-side function that walks ancestors.

export function parseColor(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/) || String(str).match(/color\(srgb ([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (String(str).startsWith("color(")) return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts[3] ?? 1 };
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}
const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });

/**
 * Runs in the browser. Returns {fg, bg} computed colour strings for an element: the text colour and the first
 * non-transparent ancestor background (falling back to white). Gradients/images are reported as `image: true`.
 */
export function contrastProbe(el) {
  let bg = "rgba(255, 255, 255, 1)";
  let image = false;
  for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    const cs = getComputedStyle(n);
    if (cs.backgroundImage && cs.backgroundImage !== "none") image = true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      if ((p[3] ?? 1) > 0.5) {
        bg = cs.backgroundColor;
        break;
      }
    }
  }
  return { fg: getComputedStyle(el).color, bg, image };
}

/** Contrast of an element's text against its effective background, as a number. */
export async function textContrast(locator) {
  const { fg, bg } = await locator.evaluate(contrastProbe);
  const b = parseColor(bg);
  const f = parseColor(fg);
  return contrastRatio(f.a < 1 ? over(f, b) : f, b);
}

/**
 * Contrast of every visible element matched by `locator` that has its own text (up to `limit`), as
 * [{text, ratio, fg, bg}]. Disabled controls are skipped (WCAG exempts inactive components).
 */
export async function contrastReport(locator, { limit = 25 } = {}) {
  const out = [];
  const n = Math.min(await locator.count(), limit);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (!(await el.isVisible())) continue;
    const info = await el.evaluate((node) => ({ own: [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || node.matches("input, select, textarea"), disabled: node.matches(":disabled") || node.getAttribute("aria-disabled") === "true", text: (node.value || node.textContent || "").trim().slice(0, 40) }));
    if (!info.own || info.disabled) continue;
    const { fg, bg } = await el.evaluate(contrastProbe);
    const b = parseColor(bg);
    const f = parseColor(fg);
    out.push({ text: info.text, ratio: contrastRatio(f.a < 1 ? over(f, b) : f, b), fg, bg });
  }
  return out;
}
