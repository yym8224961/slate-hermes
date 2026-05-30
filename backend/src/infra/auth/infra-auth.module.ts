import { Global, Module } from '@nestjs/common';
import { JwtTokenService } from './jwt-token.service';
import { DeviceSecretAuthCacheService } from './device-secret-auth-cache.service';

@Global()
@Module({
  providers: [JwtTokenService, DeviceSecretAuthCacheService],
  exports: [JwtTokenService, DeviceSecretAuthCacheService],
})
export class InfraAuthModule {}
