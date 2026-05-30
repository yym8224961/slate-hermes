import { Module } from '@nestjs/common';
import { InfraAuthModule } from '../../infra/auth/infra-auth.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [UsersModule, InfraAuthModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRateLimitGuard],
})
export class AuthModule {}
