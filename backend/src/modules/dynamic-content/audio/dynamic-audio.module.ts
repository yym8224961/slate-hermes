import { Module } from '@nestjs/common';
import { GroupsModule } from '../../groups/groups.module';
import { TtsModule } from '../../tts/tts.module';
import { DynamicAudioService } from './dynamic-audio.service';

@Module({
  imports: [GroupsModule, TtsModule],
  providers: [DynamicAudioService],
  exports: [DynamicAudioService],
})
export class DynamicAudioModule {}
