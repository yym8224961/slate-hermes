import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './infra/config/config.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { BlobModule } from './infra/blob/blob.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DevicesModule } from './modules/devices/devices.module';
import { GroupsModule } from './modules/groups/groups.module';
import { ContentsModule } from './modules/contents/contents.module';
import { RenderModule } from './modules/render/render.module';
import { AudioModule } from './modules/audio/audio.module';
import { WidgetsModule } from './modules/widgets/widgets.module';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    BlobModule,
    HealthModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    DevicesModule,
    RenderModule,
    AudioModule,
    ContentsModule,
    WidgetsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
