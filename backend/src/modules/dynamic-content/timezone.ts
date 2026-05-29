export function timezoneFromConfig(config: unknown): string {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const tz = (config as Record<string, unknown>).tz;
    if (typeof tz === 'string' && tz.trim()) return tz;
  }
  return 'Asia/Shanghai';
}

export function datePartsInTz(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value ?? 1970),
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 1),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 1),
  };
}

export function cnMonthDay(date: Date, timeZone: string): string {
  const parts = datePartsInTz(date, timeZone);
  return `${parts.month}月${parts.day}日`;
}

export function utcOffsetMin(date: Date, timeZone: string): number {
  const parts = dateTimePartsInTz(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export interface WallTimeParts {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export function utcFromWallTimeInTz(parts: WallTimeParts, timeZone: string): Date | null {
  const normalized = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
      parts.millisecond ?? 0
    )
  );
  if (Number.isNaN(normalized.getTime())) return null;

  const target = {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
    day: normalized.getUTCDate(),
    hour: normalized.getUTCHours(),
    minute: normalized.getUTCMinutes(),
    second: normalized.getUTCSeconds(),
    millisecond: normalized.getUTCMilliseconds(),
  };
  const targetLocalMs = wallTimeMs(target);
  const offsets = offsetsAround(normalized.getTime(), timeZone);
  const candidates = [...offsets]
    .map((offset) => new Date(normalized.getTime() - offset * 60_000))
    .filter(
      (date, index, all) => all.findIndex((other) => other.getTime() === date.getTime()) === index
    )
    .map((date) => ({ date, local: dateTimePartsInTz(date, timeZone) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const exact = candidates.find((candidate) => sameWallTime(candidate.local, target));
  if (exact) return exact.date;

  const ranked = candidates
    .map((candidate) => ({
      date: candidate.date,
      delta: wallTimeMs(candidate.local) - targetLocalMs,
    }))
    .filter((candidate) => Number.isFinite(candidate.delta));
  const forward = ranked
    .filter((candidate) => candidate.delta >= 0)
    .sort((a, b) => a.delta - b.delta || a.date.getTime() - b.date.getTime())[0];
  if (forward) return forward.date;
  return (
    ranked.sort(
      (a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.date.getTime() - b.date.getTime()
    )[0]?.date ?? null
  );
}

export function nextLocalMidnight(now: Date, timeZone: string): Date {
  const parts = datePartsInTz(now, timeZone);
  const midnight = utcFromWallTimeInTz(
    { year: parts.year, month: parts.month, day: parts.day + 1 },
    timeZone
  );
  if (!midnight) {
    throw new Error(`failed to compute next local midnight for time zone ${timeZone}`);
  }
  return midnight;
}

function offsetsAround(utcMs: number, timeZone: string): Set<number> {
  const offsets = new Set<number>();
  for (const delta of [-48, -24, -12, 0, 12, 24, 48]) {
    offsets.add(utcOffsetMin(new Date(utcMs + delta * 60 * 60_000), timeZone));
  }
  return offsets;
}

function dateTimePartsInTz(date: Date, timeZone: string): Required<WallTimeParts> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

function sameWallTime(a: Required<WallTimeParts>, b: Required<WallTimeParts>): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

function wallTimeMs(parts: Required<WallTimeParts>): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
}
