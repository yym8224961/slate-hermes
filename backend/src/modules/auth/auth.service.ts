import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { LoginRequestT, LoginResponseT, RegisterRequestT, RegisterResponseT } from 'shared';
import { AuthError } from '../../common/errors';
import { UsersService } from '../users/users.service';
import { JwtTokenService } from './jwt-token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: JwtTokenService
  ) {}

  async login(input: LoginRequestT): Promise<LoginResponseT> {
    const user = await this.users.findByIdentifier(input.identifier);
    if (!user) throw new AuthError('invalid credentials');
    const ok = await bcrypt.compare(input.password, user.password);
    if (!ok) throw new AuthError('invalid credentials');

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
