import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';
import { AuthError } from '../../common/errors';
import { UsersService } from '../users/users.service';
import { JwtTokenService } from './jwt-token.service';

const DUMMY_PASSWORD_HASH = '$2b$10$tx7P.bQxwBewVb262ZeE9.tgvaB9iCmuujKGtH1gkt8.xkUgcqixu';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: JwtTokenService
  ) {}

  async login(input: LoginRequestT): Promise<LoginResponseT> {
    const user = await this.users.findByIdentifier(input.identifier);
    const ok = await bcrypt.compare(input.password, user?.password ?? DUMMY_PASSWORD_HASH);
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
