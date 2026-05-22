import type { FastifyRequest } from 'fastify';

export function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function extractCookieToken(req: FastifyRequest): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  if (cookies?.auth_token) return cookies.auth_token;

  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function extractWebToken(req: FastifyRequest): string | null {
  return extractBearerToken(req) ?? extractCookieToken(req);
}
