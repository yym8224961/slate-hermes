import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from './infra/config/config.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { BlobModule } from './infra/blob/blob.module';
import { InfraAuthModule } from './infra/auth/infra-auth.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DevicesModule } from './modules/devices/devices.module';
import { GroupsModule } from './modules/groups/groups.module';
import { ContentsModule } from './modules/contents/contents.module';
import { ImageRendererModule } from './modules/image-renderer/image-renderer.module';
import { AudioModule } from './modules/audio/audio.module';
import { AiModule } from './modules/ai/ai.module';
import { TtsModule } from './modules/tts/tts.module';
import { DynamicContentModule } from './modules/dynamic-content/dynamic-content.module';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    BlobModule,
    InfraAuthModule,
    GroupsModule,
    ImageRendererModule,
    AudioModule,
    AiModule,
    TtsModule,
    DynamicContentModule,
    ContentsModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DevicesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
