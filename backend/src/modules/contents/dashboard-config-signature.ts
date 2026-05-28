export function dashboardPayloadConfigChanged(current: unknown, next: unknown): boolean {
  return (
    stableJson(dashboardPayloadConfigSignature(current)) !==
    stableJson(dashboardPayloadConfigSignature(next))
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function dashboardPayloadConfigSignature(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  return {
    template: config.template,
    test_data: config.test_data,
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)])
  );
}
