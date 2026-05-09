import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { RenderModule } from '../render/render.module';
import { AudioModule } from '../audio/audio.module';
import { FramesController } from './frames.controller';
import { FramesService } from './frames.service';
import { MultipartParser } from './multipart.parser';

@Module({
  imports: [GroupsModule, RenderModule, AudioModule],
  controllers: [FramesController],
  providers: [FramesService, MultipartParser],
  exports: [FramesService],
})
export class FramesModule {}
