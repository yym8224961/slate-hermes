import { Injectable } from '@nestjs/common';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { AppConfig } from '../../infra/config/app.config';
import { AuthError } from '../../common/errors';
import type { WebUserContext } from '../../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtTokenService {
  constructor(private readonly config: AppConfig) {}

  sign(payload: { sub: string; email: string; username: string }): string {
    const opts: SignOptions = {
      expiresIn: this.config.jwtExpiration as SignOptions['expiresIn'],
    };
    return jwt.sign(payload, this.config.jwtSecret, opts);
  }

  verify(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.config.jwtSecret) as JwtPayload;
    } catch {
      throw new AuthError('令牌无效或已过期');
    }
  }

  tryVerifyUser(token: string | null | undefined): WebUserContext | null {
    if (!token) return null;
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
      if (!payload?.sub) return null;
      return {
        userId: payload.sub,
        email: payload.email,
        username: payload.username ?? '',
      };
    } catch {
      return null;
    }
  }
}
