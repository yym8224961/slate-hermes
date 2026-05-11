import { Injectable } from '@nestjs/common';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { AppConfig } from '../../infra/config/app.config';
import { AuthError } from '../../common/errors';

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
}
