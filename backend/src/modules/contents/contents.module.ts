import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ImageRendererModule } from '../image-renderer/image-renderer.module';
import { AudioModule } from '../audio/audio.module';
import { TtsModule } from '../tts/tts.module';
import { DynamicContentModule } from '../dynamic-content/dynamic-content.module';
import { ContentsController } from './contents.controller';
import { DashboardIngestController } from './dashboard-ingest.controller';
import { ContentsReadService } from './contents-read.service';
import { ContentsService } from './contents.service';
import { IngestPayloadSizeGuard } from './ingest-payload-size.guard';
import { IngestPayloadSizePipe } from './ingest-payload-size.pipe';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { DeviceCurrentContentService } from './device-current-content.service';
import { MultipartParser } from './multipart.parser';

@Module({
  imports: [GroupsModule, ImageRendererModule, AudioModule, TtsModule, DynamicContentModule],
  controllers: [ContentsController, DashboardIngestController],
  providers: [
    ContentsService,
    ContentsReadService,
    MultipartParser,
    IngestPayloadSizeGuard,
    IngestPayloadSizePipe,
    IngestRateLimitGuard,
    ContentAudioBlobService,
    DeviceCurrentContentService,
  ],
  exports: [ContentsService, ContentsReadService, DeviceCurrentContentService],
})
export class ContentsModule {}
