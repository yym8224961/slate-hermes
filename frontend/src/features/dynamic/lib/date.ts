export function zonedDateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = getDatePartsFormatter(timeZone).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value ?? 1970),
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 1),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 1),
  };
}

const datePartsFormatters = new Map<string, Intl.DateTimeFormat>();

function getDatePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = datePartsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    datePartsFormatters.set(timeZone, formatter);
  }
  return formatter;
}
