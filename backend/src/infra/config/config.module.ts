import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { EnvSchema } from './env.schema';
import { AppConfig } from './app.config';

const logger = new Logger('ConfigModule');

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => {
        const parsed = EnvSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
          logger.error(`Invalid environment variables: ${issues}`);
          throw parsed.error;
        }
        return parsed.data;
      },
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
