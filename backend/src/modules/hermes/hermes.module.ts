import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TtsModule } from '../tts/tts.module';
import { HermesController } from './hermes.controller';
import { HermesService } from './hermes.service';

@Module({
  imports: [AiModule, TtsModule],
  controllers: [HermesController],
  providers: [HermesService],
})
export class HermesModule {}
