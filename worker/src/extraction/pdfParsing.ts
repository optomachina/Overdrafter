/** Small forward-only scanners for untrusted Poppler text and SVG output. */
const digit = (text: string, at: number) => text[at] !== undefined && text[at]! >= "0" && text[at]! <= "9";

/** End of [-+]?(digits* dot)?digits+(e[-+]?digits+)?, or start when absent. */
function numberEnd(text: string, start: number): number {
  let at = start;
  if (text[at] === "+" || text[at] === "-") at++;
  const integer = at;
  while (digit(text, at)) at++;
  const hasInteger = at > integer;
  if (text[at] === "." && digit(text, at + 1)) {
    at += 2;
    while (digit(text, at)) at++;
  } else if (!hasInteger) {
    return start;
  }
  if (text[at] === "e" || text[at] === "E") {
    let exponent = at + 1;
    if (text[exponent] === "+" || text[exponent] === "-") exponent++;
    if (digit(text, exponent)) {
      at = exponent + 1;
      while (digit(text, at)) at++;
    }
  }
  return at;
}

export function svgNumbers(text: string): number[] {
  const values: number[] = [];
  for (let at = 0; at < text.length;) {
    const end = numberEnd(text, at);
    if (end === at) at++;
    else { values.push(Number(text.slice(at, end))); at = end; }
  }
  return values;
}

/** Cairo's absolute commands only; reject unknown text rather than skipping it. */
export function svgPathTokens(text: string): string[] | null {
  const tokens: string[] = [];
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char === "," || /\s/.test(char)) { at++; continue; }
    if ("MLCQZ".includes(char)) { tokens.push(char); at++; continue; }
    const end = numberEnd(text, at);
    if (end === at) return null;
    tokens.push(text.slice(at, end));
    at = end;
  }
  return tokens;
}

/** Consume through the next closing delimiter once, including malformed tags. */
export function* svgTags(text: string, anyName = false): Generator<{ tag: string; start: number; end: number }> {
  const named = /<\/?[A-Za-z]/y;
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf("<", at);
    if (start < 0) return;
    named.lastIndex = start;
    if (!anyName && !named.test(text)) { at = start + 1; continue; }
    const end = text.indexOf(">", start + 1);
    if (end < 0) return;
    yield { tag: text.slice(start, end + 1), start, end: end + 1 };
    at = end + 1;
  }
}

export function trimDimensionPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && (token[end - 1] === "," || token[end - 1] === ";")) end--;
  return token.slice(0, end);
}

export function hasToleranceLabel(text: string): boolean {
  return /\b(?:unless otherwise specified|general tolerances?|tolerances?)\b/i.test(text) ||
    /(?:^|\s)X?\.X{1,4}(?=\s|=|$)/im.test(text);
}
