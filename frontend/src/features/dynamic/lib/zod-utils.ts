interface SafeParseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export function createSafeParseGuard<T>(schema: SafeParseSchema<T>) {
  return (value: unknown): value is T => schema.safeParse(value).success;
}
