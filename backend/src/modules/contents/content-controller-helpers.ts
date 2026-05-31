import type { FastifyReply } from 'fastify';
import type { DeviceContext, WebUserContext } from '../../common/nest/auth-context';

export function abortSignalForReply(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

export function contentAuthScope(
  user: WebUserContext | undefined,
  device: DeviceContext | undefined
): { userId?: string; deviceId?: string } {
  return {
    userId: user?.userId,
    deviceId: device?.deviceId,
  };
}
