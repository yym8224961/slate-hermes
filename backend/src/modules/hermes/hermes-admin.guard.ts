import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '../../common/errors';
import { CURRENT_USER_KEY, type WebUserContext } from '../../common/nest/auth-context';
import { UsersService } from '../users/users.service';

@Injectable()
export class HermesAdminGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext }>();
    const userId = req[CURRENT_USER_KEY]?.userId;
    if (!userId || !(await this.users.isAdmin(userId))) {
      throw new ForbiddenError('只有管理员可以修改 Hermes Token');
    }
    return true;
  }
}
