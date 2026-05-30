import { Prisma } from '@prisma/client';

export function toPrismaInputJson(value: unknown): Prisma.InputJsonValue {
  if (isPrismaInputJsonValue(value)) return value;
  throw new Error('value is not JSON-compatible');
}

function isPrismaInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (value === null || value === undefined) return false;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every(isPrismaJsonArrayValue);
      if (!isPlainJsonObject(value)) return false;
      return Object.values(value).every(isPrismaJsonObjectValue);
    default:
      return false;
  }
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPrismaJsonArrayValue(value: unknown): value is Prisma.InputJsonValue | null {
  return value === null || isPrismaInputJsonValue(value);
}

function isPrismaJsonObjectValue(value: unknown): value is Prisma.InputJsonValue | null {
  return value === null || isPrismaInputJsonValue(value);
}
