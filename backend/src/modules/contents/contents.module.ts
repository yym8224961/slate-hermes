import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ImageRendererModule } from '../image-renderer/image-renderer.module';
import { AudioModule } from '../audio/audio.module';
import { TtsModule } from '../tts/tts.module';
import { DynamicContentModule } from '../dynamic-content/dynamic-content.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ContentsController } from './contents.controller';
import { ContentDataController } from './content-data.controller';
import { ContentsService } from './contents.service';
import { IngestLimitGuard } from './ingest-limit.guard';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { MultipartParser } from './multipart.parser';

@Module({
  imports: [
    GroupsModule,
    ImageRendererModule,
    AudioModule,
    TtsModule,
    DynamicContentModule,
    AuthModule,
  ],
  controllers: [ContentsController, ContentDataController],
  providers: [
    ContentsService,
    MultipartParser,
    IngestLimitGuard,
    ContentAudioBlobService,
    JwtAuthGuard,
  ],
  exports: [ContentsService],
})
export class ContentsModule {}
