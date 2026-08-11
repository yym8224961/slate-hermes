import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TtsModule } from '../tts/tts.module';
import { HermesController } from './hermes.controller';
import { HermesService } from './hermes.service';
import { HermesAgentAuthGuard } from './hermes-agent-auth.guard';
import { HermesTokenStore } from './hermes-token.store';

@Module({
  imports: [AiModule, TtsModule],
  controllers: [HermesController],
  providers: [HermesService, HermesAgentAuthGuard, HermesTokenStore],
  exports: [HermesTokenStore],
})
export class HermesModule {}
