import { Module } from '@nestjs/common';
import { AiConfig } from './ai.config';
import { AiService } from './ai.service';

@Module({
  providers: [AiConfig, AiService],
  exports: [AiConfig, AiService],
})
export class AiModule {}
