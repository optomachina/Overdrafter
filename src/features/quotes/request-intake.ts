import { parseRequestQuantityText } from "@/features/quotes/single-quantity";
import { addDays, addWeeks, format, isBefore, parse, startOfDay } from "date-fns";
import {
  DEFAULT_REQUESTED_SERVICE_KIND,
  normalizeRequestedServiceIntent,
  type RequestedServiceIntent,
  type RequestedServiceKind,
} from "@/features/quotes/service-intent";

const MONTH_NAME_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_PATTERN =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const DATE_INTENT_PATTERN =
  "\\b(?:need\\s+by|deliver\\s+by|receive\\s+by|ship\\s+by|due(?:\\s+date)?|by)\\b";

const EXPLICIT_DATE_PATTERNS = [
  new RegExp(`${DATE_INTENT_PATTERN}\\s+(${MONTH_NAME_PATTERN}\\s+\\d{1,2}(?:,\\s*\\d{4}|\\s+\\d{4})?)`, "i"),
  new RegExp(`${DATE_INTENT_PATTERN}\\s+(\\d{4}-\\d{1,2}-\\d{1,2})`, "i"),
  new RegExp(`${DATE_INTENT_PATTERN}\\s+(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`, "i"),
];

const RELATIVE_DATE_PATTERN = new RegExp(
  `${DATE_INTENT_PATTERN}\\s+(today|tomorrow|next\\s+${WEEKDAY_PATTERN}|in\\s+\\d+\\s+(?:day|days|week|weeks))\\b`,
  "i",
);

// Digits with optional dots, joined by "/" or ","; dots are kept so "12.5" is seen whole and rejected
// later instead of being read as 12. A trailing sentence period is stripped in parseQuantityRun.
const QUANTITY_RUN = String.raw`\d[\d.]*(?:(?:\s*\/\s*|,\s*)\d[\d.]*)*`;
// (?=(?<run>x))\k<run> is an atomic group: backtracking can never shorten the run, so a quantity is
// never truncated. The guards reject a run that continues as a part number or alloy (6061-T6), a
// space-grouped number or range (10 000, 10 - 20, 10 to 20) or a lead time (2 weeks).
const WHOLE_QUANTITY_RUN =
  String.raw`(?=(?<run>${QUANTITY_RUN}))\k<run>(?![\w-])(?!\s*(?:[-–']\s*)?\d)(?!\s+to\s+\d)(?!\s*(?:days?|weeks?|months?)\b)`;
const QUANTITY_UNIT_PATTERN = "(?:of|these|pcs|pieces|parts|units|ea)";

const QUANTITY_INTENT_PATTERNS = [
  new RegExp(String.raw`\bneed\s+${WHOLE_QUANTITY_RUN}(?=\s+${QUANTITY_UNIT_PATTERN}\b)`, "gi"),
  new RegExp(
    String.raw`\b(?:qty|quantity|quantities|quote|quotes|quoted|order|orders|ordering|build|builds|want|wants|price|prices|pricing)\b[^0-9]{0,20}${WHOLE_QUANTITY_RUN}`,
    "gi",
  ),
  // A slash list with no keyword counts only when a unit follows it ("10/25/50 pcs please"). The
  // lookbehind keeps a match from starting inside a number or list ("000/2,000" in "1,000/2,000").
  new RegExp(
    String.raw`(?<![\w.,\/-]\s*)(?=\d[\d.,]*\s*\/)${WHOLE_QUANTITY_RUN}(?=\s+${QUANTITY_UNIT_PATTERN}\b)`,
    "gi",
  ),
];

const THOUSANDS_GROUPED_PATTERN = /^\d{1,3}(?:,\d{3})+$/;

const WEEKDAY_BY_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export type ParsedRequestIntake = {
  requestedServiceKinds: string[];
  primaryServiceKind: string | null;
  serviceNotes: string | null;
  requestedQuoteQuantities: number[];
  /**
   * OVD-992: parsed for display only. Do not save it into a draft: a saved date is copied into the
   * approved requirement, and every controlled dispatch denies a request that carries one.
   */
  requestedByDate: string | null;
};

type DateMatch = {
  requestedByDate: string | null;
  start: number;
  end: number;
};

type ServiceKeywordRule = {
  serviceKind: Exclude<RequestedServiceKind, "manufacturing_quote">;
  patterns: RegExp[];
};

const QUOTE_SERVICE_PATTERNS = [
  /\b(?:rfq|quote|quotes|quoted|pricing|price\s+quote)\b/i,
  /\b(?:machine|machining|manufacture|manufacturing)\b/i,
];
const DEFAULT_QUANTITY_PRICING_LADDER = [1, 10, 100, 1000] as const;
const QUANTITY_PRICING_PATTERNS = [
  /\bquantity[-\s]?(?:pricing|prices|price|curves?|ladders?)\b/i,
  /\b(?:quantity|qty)[-\s]?(?:pricing|price)\b/i,
  /\b(?:pricing|price)\s+(?:breaks|tiers|curves?|ladders?)\b/i,
  /\bqty\s+(?:breaks|tiers|curves?|ladders?)\b/i,
];

const SERVICE_KEYWORD_RULES: ServiceKeywordRule[] = [
  {
    serviceKind: "cad_modeling",
    patterns: [
      /\bcad\s+(?:model|modeling|modelling|remodel(?:ing)?|rebuild)\b/i,
      /\b(?:3d|three[-\s]?dimensional)\s+model(?:ing)?\b/i,
      /\bmodel\s+this\s+(?:part|component)\b/i,
    ],
  },
  {
    serviceKind: "drawing_redraft",
    patterns: [
      /\bdrawing\s+(?:redraft|redraw|cleanup|clean[-\s]?up|reissue)\b/i,
      /\bredraft\b/i,
      /\b(?:release\s+package|manufacturing\s+drawing)\b/i,
    ],
  },
  {
    serviceKind: "fea_analysis",
    patterns: [
      /\bfea\b/i,
      /\bfinite\s+element\b/i,
      /\bstress\s+analysis\b/i,
      /\bsimulation\b/i,
    ],
  },
  {
    serviceKind: "dfm_review",
    patterns: [
      /\bdfm\b/i,
      /\bdesign\s+for\s+manufactur(?:e|ability)\b/i,
      /\bmanufacturability\s+review\b/i,
    ],
  },
  {
    serviceKind: "dfa_review",
    patterns: [
      /\bdfa\b/i,
      /\bdesign\s+for\s+assembly\b/i,
      /\bassembly\s+review\b/i,
    ],
  },
  {
    serviceKind: "assembly_support",
    patterns: [
      /\bassembly\s+support\b/i,
      /\bbom\b/i,
      /\bfit(?:[-\s]?up)?\b/i,
      /\bsequence\s+review\b/i,
    ],
  },
  {
    serviceKind: "sourcing_only",
    patterns: [
      /\bsourcing\s+only\b/i,
      /\bsource\s+only\b/i,
      /\bprocurement\s+support\b/i,
      /\bsupplier\s+sourcing\b/i,
    ],
  },
];

function replaceRangeWithSpaces(value: string, start: number, end: number) {
  return `${value.slice(0, start)}${" ".repeat(Math.max(0, end - start))}${value.slice(end)}`;
}

function parseExplicitMonthDate(value: string, now: Date): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  const hasYear = /\b\d{4}\b/.test(normalized);
  const currentYear = now.getFullYear();
  const candidate = hasYear
    ? parse(normalized.replace(",", ""), "MMMM d yyyy", now)
    : parse(`${normalized} ${currentYear}`.replace(",", ""), "MMMM d yyyy", now);

  if (Number.isNaN(candidate.getTime())) {
    const shortCandidate = hasYear
      ? parse(normalized.replace(",", ""), "MMM d yyyy", now)
      : parse(`${normalized} ${currentYear}`.replace(",", ""), "MMM d yyyy", now);

    if (Number.isNaN(shortCandidate.getTime())) {
      return null;
    }

    return resolveExplicitDate(shortCandidate, hasYear, now);
  }

  return resolveExplicitDate(candidate, hasYear, now);
}

function resolveExplicitDate(candidate: Date, hasYear: boolean, now: Date): string | null {
  let resolved = startOfDay(candidate);

  if (!hasYear && isBefore(resolved, startOfDay(now))) {
    resolved = parse(
      `${resolved.getMonth() + 1}/${resolved.getDate()}/${now.getFullYear() + 1}`,
      "M/d/yyyy",
      now,
    );
  }

  return Number.isNaN(resolved.getTime()) ? null : format(resolved, "yyyy-MM-dd");
}

function parseSlashDate(value: string, now: Date): string | null {
  const parts = value.trim().split("/");

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const month = Number.parseInt(parts[0] ?? "", 10);
  const day = Number.parseInt(parts[1] ?? "", 10);

  if (!Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const currentYear = now.getFullYear();
  const year =
    parts.length === 3
      ? normalizeYear(Number.parseInt(parts[2] ?? "", 10), currentYear)
      : currentYear;
  const candidate = parse(`${month}/${day}/${year}`, "M/d/yyyy", now);

  if (Number.isNaN(candidate.getTime())) {
    return null;
  }

  return resolveExplicitDate(candidate, parts.length === 3, now);
}

function parseIsoDate(value: string, now: Date): string | null {
  const candidate = parse(value.trim(), "yyyy-M-d", now);
  return Number.isNaN(candidate.getTime()) ? null : format(startOfDay(candidate), "yyyy-MM-dd");
}

function normalizeYear(value: number, currentYear: number) {
  if (!Number.isFinite(value)) {
    return currentYear;
  }

  if (value >= 100) {
    return value;
  }

  const currentCentury = Math.floor(currentYear / 100) * 100;
  return currentCentury + value;
}

function parseRelativeDate(value: string, now: Date): string | null {
  const normalized = value.trim().toLowerCase();
  const today = startOfDay(now);

  if (normalized === "today") {
    return format(today, "yyyy-MM-dd");
  }

  if (normalized === "tomorrow") {
    return format(addDays(today, 1), "yyyy-MM-dd");
  }

  const nextWeekdayMatch = normalized.match(new RegExp(`^next\\s+(${WEEKDAY_PATTERN})$`, "i"));
  if (nextWeekdayMatch) {
    const weekday = WEEKDAY_BY_NAME[nextWeekdayMatch[1]!.toLowerCase()];
    return format(nextWeekday(today, weekday), "yyyy-MM-dd");
  }

  const durationMatch = normalized.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1] ?? "0", 10);

    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    const unit = durationMatch[2] ?? "days";
    return format(unit.startsWith("week") ? addWeeks(today, amount) : addDays(today, amount), "yyyy-MM-dd");
  }

  return null;
}

function nextWeekday(now: Date, weekday: number): Date {
  const currentWeekday = now.getDay();
  const delta = ((weekday - currentWeekday + 7) % 7) || 7;
  return addDays(now, delta);
}

function parseDateMatch(prompt: string, now: Date): DateMatch | null {
  const explicitMatch =
    EXPLICIT_DATE_PATTERNS.map((pattern) => prompt.match(pattern)).find((match) => Boolean(match?.[1])) ?? null;

  if (explicitMatch?.[1] && typeof explicitMatch.index === "number") {
    const parsedDate =
      explicitMatch[1].includes("-")
        ? parseIsoDate(explicitMatch[1], now)
        : explicitMatch[1].includes("/")
          ? parseSlashDate(explicitMatch[1], now)
          : parseExplicitMonthDate(explicitMatch[1], now);

    return {
      requestedByDate:
        parsedDate && !Number.isNaN(new Date(parsedDate).getTime()) ? parsedDate : null,
      start: explicitMatch.index,
      end: explicitMatch.index + explicitMatch[0].length,
    };
  }

  const relativeMatch = prompt.match(RELATIVE_DATE_PATTERN);
  if (relativeMatch?.[1] && typeof relativeMatch.index === "number") {
    return {
      requestedByDate: parseRelativeDate(relativeMatch[1], now),
      start: relativeMatch.index,
      end: relativeMatch.index + relativeMatch[0].length,
    };
  }

  return null;
}

function parseQuantityNumber(token: string): number | null {
  return parseRequestQuantityText(THOUSANDS_GROUPED_PATTERN.test(token) ? token.replace(/,/g, "") : token);
}

/**
 * One comma-joined chunk as quantities, or null when it is malformed or ambiguous. "1,000" can only be
 * a thousands group and "10,25,50" can only be a list, but "250,500" reads both ways, so the intent is
 * unknowable. Unlike validateRequestedQuoteQuantitiesInput, which rejects any thousands group in the
 * editor field without a "/" or ";", a lone group here ("1,000") is read as one quantity.
 */
function parseCommaChunk(chunk: string): number[] | null {
  const pieces = chunk.split(",").map(parseRequestQuantityText);
  const piecesAreQuantities = pieces.every((quantity) => quantity !== null);
  if (!THOUSANDS_GROUPED_PATTERN.test(chunk)) {
    return piecesAreQuantities ? (pieces as number[]) : null;
  }
  const grouped = parseQuantityNumber(chunk);
  return grouped !== null && !piecesAreQuantities ? [grouped] : null;
}

/** All quantities in a run, or null when any part is malformed or ambiguous. */
function parseQuantityRun(run: string): number[] | null {
  let end = run.length;
  while (end > 0 && run[end - 1] === ".") end -= 1;
  const text = run.slice(0, end);
  // With a slash present, commas inside an item can only be thousands groups ("1,000 / 2,000").
  const parts = text.includes("/")
    ? text.split("/").map((segment) => {
        const quantity = parseQuantityNumber(segment.trim());
        return quantity === null ? null : [quantity];
      })
    : text.split(/,\s+/).map(parseCommaChunk);
  return parts.every((part) => part !== null) ? parts.flat() : null;
}

/**
 * Quantities from every quantity-intent run in the prompt, or null when any run was present but
 * unreadable, so a caller leaves the quantities unfilled instead of filling a default.
 */
function collectQuantityCandidates(value: string): number[] | null {
  const runs = QUANTITY_INTENT_PATTERNS.flatMap((pattern) =>
    Array.from(value.matchAll(pattern), (match) => parseQuantityRun(match.groups?.run ?? "")),
  );
  return runs.every((run) => run !== null) ? runs.flat() : null;
}

function parseServiceIntent(prompt: string): RequestedServiceIntent {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return normalizeRequestedServiceIntent({
      requestedServiceKinds: [DEFAULT_REQUESTED_SERVICE_KIND],
      primaryServiceKind: DEFAULT_REQUESTED_SERVICE_KIND,
    });
  }

  const detectedServices = SERVICE_KEYWORD_RULES.flatMap((rule) => {
    const positions = rule.patterns
      .map((pattern) => trimmedPrompt.search(pattern))
      .filter((position) => position >= 0);

    if (positions.length === 0) {
      return [];
    }

    return [{ serviceKind: rule.serviceKind, position: Math.min(...positions) }];
  }).sort((left, right) => left.position - right.position);

  const requestedServiceKinds: RequestedServiceKind[] = detectedServices.map((service) => service.serviceKind);
  const hasQuoteSignal = QUOTE_SERVICE_PATTERNS.some((pattern) => pattern.test(trimmedPrompt));

  if (hasQuoteSignal || requestedServiceKinds.length === 0) {
    requestedServiceKinds.push(DEFAULT_REQUESTED_SERVICE_KIND);
  }

  return normalizeRequestedServiceIntent({
    requestedServiceKinds,
    primaryServiceKind: detectedServices[0]?.serviceKind ?? DEFAULT_REQUESTED_SERVICE_KIND,
  });
}

export function normalizeRequestedQuoteQuantities(
  values: readonly unknown[] | null | undefined,
  fallbackQuantity?: number | null,
): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();

  values?.forEach((value) => {
    const parsed =
      typeof value === "number"
        ? Math.trunc(value)
        : typeof value === "string" && value.trim()
          ? Number.parseInt(value.trim(), 10)
          : Number.NaN;

    if (!Number.isFinite(parsed) || parsed <= 0 || seen.has(parsed)) {
      return;
    }

    seen.add(parsed);
    normalized.push(parsed);
  });

  if (normalized.length > 0) {
    return normalized;
  }

  if (fallbackQuantity && fallbackQuantity > 0) {
    return [Math.trunc(fallbackQuantity)];
  }

  return [];
}

export function parseRequestedQuoteQuantitiesInput(value: string, fallbackQuantity?: number | null): number[] {
  return normalizeRequestedQuoteQuantities(
    value
      .split(/[/,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean),
    fallbackQuantity,
  );
}

export const QUOTE_QUANTITIES_AMBIGUOUS_ERROR =
  "Commas are ambiguous here. Write 1000, or separate quantities with /, like 250 / 500.";

export const QUOTE_QUANTITIES_FORMAT_ERROR =
  "Enter whole numbers separated by /, for example 10 / 25 / 50. Each must be from 1 to 2,147,483,647.";

/** Validate user input separately from the permissive normalization used for extracted data. */
export function validateRequestedQuoteQuantitiesInput(value: string, fallbackQuantity?: number | null): {
  quantities: number[];
  invalidTokens: string[];
  error?: string;
} {
  const quantities: number[] = [];
  const invalidTokens: string[] = [];
  const text = value.trim();
  if (!text) {
    const fallback = parseRequestQuantityText(String(fallbackQuantity ?? ""));
    return { quantities: fallback === null ? [] : [fallback], invalidTokens: [] };
  }
  const hasExplicitSeparator = /[/;]/.test(text);
  const commaGroup = /^\d{1,3}(,\d{3})+$/;
  const chunks = text.split(/\s+/).map((chunk) => chunk.replace(/,+$/, ""));
  if (!hasExplicitSeparator && /,\d{3}(?=,|\s|$)/.test(text)) {
    return { quantities: [], invalidTokens: [text], error: QUOTE_QUANTITIES_AMBIGUOUS_ERROR };
  }
  const tokens = hasExplicitSeparator
    ? text.split(/[/;\s]+/).filter(Boolean)
    : chunks.flatMap((chunk) => chunk.split(",")).filter(Boolean);
  for (const token of tokens) {
    const ungrouped = hasExplicitSeparator && commaGroup.test(token) ? token.replace(/,/g, "") : token;
    const quantity = parseRequestQuantityText(ungrouped);
    if (quantity === null) {
      invalidTokens.push(token);
    } else if (!quantities.includes(quantity)) {
      quantities.push(quantity);
    }
  }
  if (tokens.length === 0) {
    invalidTokens.push(text);
  }
  return { quantities, invalidTokens };
}

export function formatRequestedQuoteQuantitiesInput(quantities: readonly number[]): string {
  return quantities.join("/");
}

export function formatRequestedQuoteQuantitiesLabel(quantities: readonly number[]): string {
  return quantities.join(" / ");
}

export function formatRequestedByDateLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = parse(value, "yyyy-MM-dd", new Date());
  return Number.isNaN(parsed.getTime()) ? null : format(parsed, "MMM d, yyyy");
}

export function parseRequestIntake(prompt: string, now = new Date()): ParsedRequestIntake {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return {
      requestedServiceKinds: [DEFAULT_REQUESTED_SERVICE_KIND],
      primaryServiceKind: DEFAULT_REQUESTED_SERVICE_KIND,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
  }

  const dateMatch = parseDateMatch(trimmedPrompt, now);
  const quantitySource = dateMatch
    ? replaceRangeWithSpaces(trimmedPrompt, dateMatch.start, dateMatch.end)
    : trimmedPrompt;
  const serviceIntent = parseServiceIntent(trimmedPrompt);
  const quantityCandidates = collectQuantityCandidates(quantitySource);
  const requestedQuoteQuantities = normalizeRequestedQuoteQuantities(quantityCandidates ?? []);
  const wantsQuantityPricing = QUANTITY_PRICING_PATTERNS.some((pattern) => pattern.test(trimmedPrompt));
  let resolvedQuoteQuantities = requestedQuoteQuantities;

  if (quantityCandidates !== null && requestedQuoteQuantities.length === 0 && wantsQuantityPricing) {
    resolvedQuoteQuantities = [...DEFAULT_QUANTITY_PRICING_LADDER];
  }

  return {
    ...serviceIntent,
    requestedQuoteQuantities: resolvedQuoteQuantities,
    requestedByDate: dateMatch?.requestedByDate ?? null,
  };
}
