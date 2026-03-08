import { addDays, addWeeks, format, isBefore, parse, startOfDay } from "date-fns";

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

const SINGLE_QUANTITY_PATTERNS = [
  /\bneed\s+(\d{1,6})(?=\s+(?:of|these|pcs|pieces|parts|units|ea\b))/gi,
  /\b(?:qty|quantity|quantities|quote|quotes|quoted|order|orders|ordering|build|builds|want|wants)\b[^0-9]{0,20}(\d{1,6})\b/gi,
];

const LIST_QUANTITY_PATTERNS = [
  /\b(\d{1,6}(?:\s*\/\s*\d{1,6})+)\b/g,
  /\b(?:qty|quantity|quantities|quote|quotes|quoted|order|orders|ordering)\b[^0-9]{0,20}((?:\d{1,6}\s*,\s*)+\d{1,6})\b/gi,
];

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
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
};

type DateMatch = {
  requestedByDate: string | null;
  start: number;
  end: number;
};

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

function collectQuantityCandidates(value: string): number[] {
  const matches: number[] = [];

  LIST_QUANTITY_PATTERNS.forEach((pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      const items = match[1]
        ?.split(/[/,]/)
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((item) => Number.isFinite(item) && item > 0) ?? [];
      matches.push(...items);
      match = pattern.exec(value);
    }
  });

  SINGLE_QUANTITY_PATTERNS.forEach((pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      const quantity = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(quantity) && quantity > 0) {
        matches.push(quantity);
      }
      match = pattern.exec(value);
    }
  });

  return matches;
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
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
  }

  const dateMatch = parseDateMatch(trimmedPrompt, now);
  const quantitySource = dateMatch
    ? replaceRangeWithSpaces(trimmedPrompt, dateMatch.start, dateMatch.end)
    : trimmedPrompt;

  return {
    requestedQuoteQuantities: normalizeRequestedQuoteQuantities(collectQuantityCandidates(quantitySource)),
    requestedByDate: dateMatch?.requestedByDate ?? null,
  };
}
