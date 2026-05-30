import type { FastifyRequest } from 'fastify';

const MAX_TOKEN_CHARS = 4096;

type CookieRequest = FastifyRequest & {
  cookies?: Record<string, string | undefined>;
};

export function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return boundedToken(auth.slice(7).trim());
  }
  return null;
}

export function extractCookieToken(req: FastifyRequest): string | null {
  const value = cookieValue(req, 'auth_token');
  return value ? boundedToken(value) : null;
}

export function extractWebToken(req: FastifyRequest): string | null {
  const bearer = extractBearerToken(req);
  return bearer ?? extractCookieToken(req);
}

export function cookieValue(req: FastifyRequest, name: string): string | null {
  const cookies = (req as CookieRequest).cookies;
  const parsed = cookies?.[name];
  if (parsed) return parsed;

  const raw = req.headers.cookie;
  if (!raw) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match ? safeDecodeURIComponent(match[1]) : null;
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
