import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import type { LoginResponseT } from 'shared';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('sessions')
  @HttpCode(201)
  async login(@Body() body: LoginDto): Promise<LoginResponseT> {
    return this.auth.login(body);
  }

  @Delete('sessions/current')
  @HttpCode(204)
  logout(): void {
    // JWT 无服务端状态，撤销留待后续（Redis denylist）；此处仅占位
  }

  @Get('me')
  me(@CurrentUser() user: WebUserContext): { id: string; email: string } {
    return { id: user.userId, email: user.email };
  }
}
