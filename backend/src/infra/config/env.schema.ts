import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().or(z.string().startsWith('mysql://')),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRATION: z.string().default('7d'),
  WEBHOOK_API_KEY: z.string().min(8),
  BLOB_DIR: z.string().default('./blobs'),
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type EnvT = z.infer<typeof EnvSchema>;
