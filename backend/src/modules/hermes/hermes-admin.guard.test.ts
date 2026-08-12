import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '../../common/errors';
import { CURRENT_USER_KEY } from '../../common/nest/auth-context';
import type { UsersService } from '../users/users.service';
import { HermesAdminGuard } from './hermes-admin.guard';

describe('HermesAdminGuard', () => {
  it('allows only a database-confirmed administrator', async () => {
    const guard = new HermesAdminGuard(users(true));

    await expect(guard.canActivate(context('admin-1'))).resolves.toBe(true);
  });

  it('rejects an ordinary authenticated user', async () => {
    const guard = new HermesAdminGuard(users(false));

    await expect(guard.canActivate(context('user-1'))).rejects.toThrow(ForbiddenError);
  });
});

function users(isAdmin: boolean): UsersService {
  return { isAdmin: async () => isAdmin } as unknown as UsersService;
}

function context(userId: string): ExecutionContext {
  const request = {
    [CURRENT_USER_KEY]: { userId, email: 'user@example.com', username: 'user' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}
