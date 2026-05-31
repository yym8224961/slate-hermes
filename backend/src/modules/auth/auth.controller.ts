import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import type { LoginResponseT, RegisterResponseT } from 'shared';
import { CurrentUser, Public } from '../../common/nest/decorators/auth-context.decorators';
import type { WebUserContext } from '../../common/nest/auth-context';
import { RateLimit } from '../../common/rate-limit/rate-limit-guard';
import { AuthService } from './auth.service';
import { authRateLimit } from './auth-rate-limit';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit(authRateLimit)
  @Post('users')
  @HttpCode(201)
  async register(@Body() body: RegisterDto): Promise<RegisterResponseT> {
    return this.auth.register(body);
  }

  @Public()
  @RateLimit(authRateLimit)
  @Post('sessions')
  @HttpCode(201)
  async login(@Body() body: LoginDto): Promise<LoginResponseT> {
    return this.auth.login(body);
  }

  @Delete('sessions/current')
  @HttpCode(204)
  logout(): void {
    // JWT 无服务端状态，撤销留待后续（Redis denylist）；此处仅占位。
  }

  @Get('users/current')
  getCurrentUser(@CurrentUser() user: WebUserContext): {
    id: string;
    email: string;
    username: string;
  } {
    return { id: user.userId, email: user.email, username: user.username };
  }
}
