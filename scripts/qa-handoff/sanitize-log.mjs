// Neutralizes untrusted (PR- or API-derived) text before it reaches a log line
// or the step summary: CR/LF, other control characters and the Unicode line
// separators become spaces, so a crafted title, ref or check name cannot forge
// extra log lines; the result is capped at maxLen with a trailing ellipsis.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const ELLIPSIS = "…";

export function sanitizeLog(value, maxLen = 200) {
  const text = String(value ?? "").replace(CONTROL_CHARS, " ");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - ELLIPSIS.length))}${ELLIPSIS}`;
}
