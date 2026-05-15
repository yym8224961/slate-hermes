import { Module, forwardRef } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { RenderModule } from '../render/render.module';
import { AudioModule } from '../audio/audio.module';
import { WidgetsModule } from '../widgets/widgets.module';
import { ContentsController } from './contents.controller';
import { ContentDataController } from './content-data.controller';
import { ContentsService } from './contents.service';
import { IngestLimitGuard } from './ingest-limit.guard';
import { MultipartParser } from './multipart.parser';

@Module({
  imports: [GroupsModule, RenderModule, AudioModule, forwardRef(() => WidgetsModule)],
  controllers: [ContentsController, ContentDataController],
  providers: [ContentsService, MultipartParser, IngestLimitGuard],
  exports: [ContentsService],
})
export class ContentsModule {}
