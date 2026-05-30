import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';
import { AuthError } from '../../common/errors';
import { JwtTokenService } from '../../infra/auth/jwt-token.service';
import { UsersService } from '../users/users.service';

const TIMING_SAFE_FALLBACK_HASH = '$2b$12$CuSHZRvMs3E1H4thc835jOrgn1306YQVah/7ePhzdlkVSZcniq/Am';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: JwtTokenService
  ) {}

  async login(input: LoginRequestT): Promise<LoginResponseT> {
    const user = await this.users.findByIdentifier(input.identifier);
    const ok = await bcrypt.compare(input.password, user?.password ?? TIMING_SAFE_FALLBACK_HASH);
    if (!user || !ok) throw new AuthError('账号或密码错误');

    const token = this.tokens.sign({
      sub: user.id,
      email: user.email,
      username: user.username ?? '',
    });
    return { token, user: { id: user.id, email: user.email, username: user.username ?? '' } };
  }

  async register(input: RegisterRequestT): Promise<RegisterResponseT> {
    const user = await this.users.create(input.email, input.username, input.password);
    const token = this.tokens.sign({
      sub: user.id,
      email: user.email,
      username: user.username ?? '',
    });
    return { token, user: { id: user.id, email: user.email, username: user.username ?? '' } };
  }
}
