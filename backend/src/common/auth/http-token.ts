import type { FastifyRequest } from 'fastify';

const MAX_TOKEN_CHARS = 4096;

export function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return boundedToken(auth.slice(7).trim());
  }
  return null;
}

export function extractCookieToken(req: FastifyRequest): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  if (cookies?.auth_token) return boundedToken(cookies.auth_token);

  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? boundedToken(safeDecodeURIComponent(match[1])) : null;
}

export function extractWebToken(req: FastifyRequest): string | null {
  return extractBearerToken(req) ?? extractCookieToken(req);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function boundedToken(value: string): string | null {
  if (value.length === 0 || value.length > MAX_TOKEN_CHARS) return null;
  return value;
}
