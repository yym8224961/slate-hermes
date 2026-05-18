import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ImageRendererModule } from '../image-renderer/image-renderer.module';
import { AudioModule } from '../audio/audio.module';
import { DynamicContentModule } from '../dynamic-content/dynamic-content.module';
import { ContentsController } from './contents.controller';
import { ContentDataController } from './content-data.controller';
import { ContentsService } from './contents.service';
import { IngestLimitGuard } from './ingest-limit.guard';
import { MultipartParser } from './multipart.parser';

@Module({
  imports: [GroupsModule, ImageRendererModule, AudioModule, DynamicContentModule],
  controllers: [ContentsController, ContentDataController],
  providers: [ContentsService, MultipartParser, IngestLimitGuard],
  exports: [ContentsService],
})
export class ContentsModule {}
