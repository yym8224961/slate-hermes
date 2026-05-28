import type { FastifyRequest } from 'fastify';

export function clientIp(req: Pick<FastifyRequest, 'ip'>): string {
  return (req.ip || 'unknown').slice(0, 128);
}
