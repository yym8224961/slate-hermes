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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = pick('hour');
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    hour === 24 ? 0 : hour,
    pick('minute'),
    pick('second')
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function nextLocalMidnight(now: Date, timeZone: string): Date {
  const parts = datePartsInTz(now, timeZone);
  const localMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0, 0);
  let utcMs = localMidnightUtc;
  // Convert local midnight to UTC by applying the zone offset, then re-check once for
  // DST/offset transitions near midnight. Two passes are enough for normal IANA zones.
  for (let i = 0; i < 2; i++) {
    utcMs = localMidnightUtc - utcOffsetMin(new Date(utcMs), timeZone) * 60_000;
  }
  return new Date(utcMs);
}
