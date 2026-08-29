import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TtsModule } from '../tts/tts.module';
import { UsersModule } from '../users/users.module';
import { HermesController } from './hermes.controller';
import { HermesService } from './hermes.service';
import { HermesAgentAuthGuard } from './hermes-agent-auth.guard';
import { HermesTokenStore } from './hermes-token.store';
import { HermesAdminGuard } from './hermes-admin.guard';

@Module({
  imports: [AiModule, TtsModule, UsersModule],
  controllers: [HermesController],
  providers: [HermesService, HermesAgentAuthGuard, HermesAdminGuard, HermesTokenStore],
  exports: [HermesTokenStore],
})
export class HermesModule {}
