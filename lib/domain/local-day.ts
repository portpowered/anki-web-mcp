import type { EpochMilliseconds } from "./entities";

const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_HOUR = 3_600_000;

export interface LocalDayBoundary {
  readonly dayKey: string;
  readonly nextDayAt: EpochMilliseconds;
  readonly timeZone: string;
}

export class LocalDayValidationError extends Error {
  readonly code = "invalid-local-day" as const;

  constructor(message: string) {
    super(message);
    this.name = "LocalDayValidationError";
  }
}

/**
 * Derive the local calendar day and the exact next-midnight instant. Calendar
 * arithmetic is intentional here: adding 24 hours would be wrong on DST days.
 */
export function getLocalDayBoundary(
  now: EpochMilliseconds,
  timeZone?: string,
): LocalDayBoundary {
  validateEpoch(now, "now");
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const current = localDateParts(now, resolvedTimeZone);
  const nextDate = nextCalendarDate(current);
  const nextDayAt = findLocalMidnight(nextDate, resolvedTimeZone);

  return {
    dayKey: formatDayKey(current),
    nextDayAt,
    timeZone: resolvedTimeZone,
  };
}

export function resolveTimeZone(timeZone?: string): string {
  const candidate = timeZone
    ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC";
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new LocalDayValidationError("timeZone must be a non-empty IANA timezone.");
  }
  try {
    // Constructing the formatter is the platform-supported timezone validator.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
  } catch {
    throw new LocalDayValidationError(
      `Unknown timezone: ${candidate}.`,
    );
  }
  return candidate;
}

function findLocalMidnight(
  target: CalendarDate,
  timeZone: string,
): EpochMilliseconds {
  const localAsUtc = Date.UTC(target.year, target.month - 1, target.day);
  const offsets = new Set<number>();

  // Sample both sides of the target. This also handles zones whose DST
  // transition changes the offset close to midnight.
  for (
    let instant = localAsUtc - 3 * MILLISECONDS_PER_DAY;
    instant <= localAsUtc + 3 * MILLISECONDS_PER_DAY;
    instant += MILLISECONDS_PER_HOUR
  ) {
    offsets.add(timeZoneOffset(instant, timeZone));
  }

  const candidates = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((candidate) => isLocalMidnight(candidate, target, timeZone))
    .sort((left, right) => left - right);

  if (candidates.length > 0) {
    return candidates[0];
  }

  // A very small number of timezones have moved their clocks at midnight,
  // making 00:00 unrepresentable. Return the first instant on the target
  // local date in that unusual case rather than inventing a 24-hour cutoff.
  let candidate = localAsUtc - timeZoneOffset(localAsUtc, timeZone);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localDateParts(candidate, timeZone);
    if (sameDate(parts, target) && parts.hour === 0 && parts.minute === 0) {
      return candidate;
    }
    candidate = localAsUtc - timeZoneOffset(candidate, timeZone);
  }

  for (let delta = 0; delta <= 6 * MILLISECONDS_PER_HOUR; delta += 60_000) {
    const forward = candidate + delta;
    if (sameDate(localDateParts(forward, timeZone), target)) {
      return forward;
    }
  }

  throw new LocalDayValidationError(
    `Unable to calculate local midnight for ${formatDayKey(target)} in ${timeZone}.`,
  );
}

function isLocalMidnight(
  timestamp: EpochMilliseconds,
  target: CalendarDate,
  timeZone: string,
): boolean {
  const parts = localDateParts(timestamp, timeZone);
  return sameDate(parts, target)
    && parts.hour === 0
    && parts.minute === 0
    && parts.second === 0;
}

function timeZoneOffset(timestamp: EpochMilliseconds, timeZone: string): number {
  const instant = Math.floor(timestamp / 1_000) * 1_000;
  const local = localDateParts(instant, timeZone);
  const displayedAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return displayedAsUtc - instant;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface DateParts extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

function localDateParts(timestamp: EpochMilliseconds, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Partial<Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>>;

  const values = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  if (values.some((value) => value === undefined || !Number.isFinite(value))) {
    throw new LocalDayValidationError("The platform could not format the supplied instant.");
  }

  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + MILLISECONDS_PER_DAY);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function sameDate(left: CalendarDate, right: CalendarDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function formatDayKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function validateEpoch(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) {
    throw new LocalDayValidationError(`${field} must be a valid epoch-millisecond value.`);
  }
}
