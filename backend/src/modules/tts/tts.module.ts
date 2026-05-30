import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { TtsConfig } from './tts.config';
import { TtsService } from './tts.service';

@Module({
  imports: [AudioModule],
  providers: [TtsConfig, TtsService],
  exports: [TtsConfig, TtsService],
})
export class TtsModule {}
