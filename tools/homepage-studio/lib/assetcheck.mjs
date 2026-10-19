// Output contract checks for a generated asset (single self-contained index.html).
export const MAX_ASSET_BYTES = 1_500_000;

export function checkAsset(html) {
  const problems = [];
  if (typeof html !== "string" || html.trim() === "") return ["The asset file is empty."];
  if (Buffer.byteLength(html) > MAX_ASSET_BYTES) problems.push("The asset is larger than 1.5 MB.");
  if (!/<html[\s>]/i.test(html)) problems.push("The asset is not a complete HTML document.");
  const stripped = html.replace(/xmlns(:\w+)?="[^"]*"/g, "");
  if (/\b(src|href|action|poster)\s*=\s*["']?\s*(https?:)?\/\//i.test(stripped)) {
    problems.push("The asset references an external URL (src/href). It must be self-contained.");
  }
  if (/url\(\s*["']?\s*(https?:)?\/\//i.test(stripped) || /@import\s+["'(]\s*(https?:)?\/\//i.test(stripped)) {
    problems.push("The asset loads an external stylesheet or font. It must be self-contained.");
  }
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(html)) {
    problems.push("The asset uses a network API. Generated assets must not use the network.");
  }
  if (!/data-theme/.test(html) || !/prefers-color-scheme/.test(html)) {
    problems.push("The asset must support both themes (data-theme and prefers-color-scheme).");
  }
  if (!/prefers-reduced-motion/.test(html)) problems.push("The asset must honor prefers-reduced-motion.");
  return problems;
}
