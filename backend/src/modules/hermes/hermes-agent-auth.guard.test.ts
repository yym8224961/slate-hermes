import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthError } from '../../common/errors';
import type { AppConfig } from '../../infra/config/app.config';
import { HermesAgentAuthGuard } from './hermes-agent-auth.guard';

const token = 'hermes-agent-token-0123456789abcdef';

describe('HermesAgentAuthGuard', () => {
  it('accepts the configured bearer token', () => {
    const guard = new HermesAgentAuthGuard(config(token, true));
    expect(guard.canActivate(context(`Bearer ${token}`))).toBe(true);
  });

  it('rejects a missing or incorrect production token', () => {
    const guard = new HermesAgentAuthGuard(config(token, true));
    expect(() => guard.canActivate(context(undefined))).toThrow(AuthError);
    expect(() => guard.canActivate(context('Bearer wrong'))).toThrow(AuthError);
  });

  it('allows an omitted token only outside production', () => {
    const guard = new HermesAgentAuthGuard(config(undefined, false));
    expect(guard.canActivate(context(undefined))).toBe(true);
  });
});

function config(hermesAgentToken: string | undefined, isProd: boolean): AppConfig {
  return { hermesAgentToken, isProd } as AppConfig;
}

function context(authorization: string | undefined): ExecutionContext {
  const request = { headers: { authorization } } as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}
