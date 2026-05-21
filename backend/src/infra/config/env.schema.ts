import { z } from 'zod';
import { DEFAULT_TTS_VOICE } from 'shared';

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const OptionalEnv = (schema: z.ZodString) =>
  z.preprocess(emptyStringToUndefined, schema.optional());

const BooleanEnv = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  ctx.addIssue({ code: 'custom', message: 'invalid boolean value' });
  return z.NEVER;
});

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRATION: z.string().default('7d'),
  BLOB_DIR: z.string().default('./blobs'),
  QWEATHER_API_KEY: OptionalEnv(z.string().min(1)),
  QWEATHER_API_HOST: OptionalEnv(z.string().url()),
  AI_API_KEY: OptionalEnv(z.string().min(1)),
  AI_BASE_URL: OptionalEnv(z.string().url()),
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  TTS_API_KEY: OptionalEnv(z.string().min(1)),
  TTS_BASE_URL: OptionalEnv(z.string().url()),
  TTS_MODEL: z.string().min(1).default('mimo-v2.5-tts'),
  TTS_DEFAULT_VOICE: z.string().min(1).default(DEFAULT_TTS_VOICE),
  BACKGROUND_WORKERS: BooleanEnv.default(true),
});

export type EnvT = z.infer<typeof EnvSchema>;
