import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { EnvSchema } from './env.schema';
import { AppConfig } from './app.config';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => {
        const parsed = EnvSchema.safeParse(raw);
        if (!parsed.success) {
          console.error('Invalid environment variables:');
          for (const issue of parsed.error.issues) {
            console.error(`  ${issue.path.join('.')}: ${issue.message}`);
          }
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
