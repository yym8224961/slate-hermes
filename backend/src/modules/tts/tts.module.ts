import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { TtsAudioCacheService, TtsService } from './tts.service';

@Module({
  imports: [AudioModule],
  providers: [TtsService, TtsAudioCacheService],
  exports: [TtsService, TtsAudioCacheService],
})
export class TtsModule {}
