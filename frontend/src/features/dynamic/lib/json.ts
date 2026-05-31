export function canonicalJsonKey(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? 'undefined';
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue((value as Record<string, unknown>)[key])])
  );
}
