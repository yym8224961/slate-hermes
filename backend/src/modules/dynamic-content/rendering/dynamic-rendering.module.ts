import { Module } from '@nestjs/common';
import { DynamicFrameRendererService } from './dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './fonts/dynamic-frame-font.service';

@Module({
  providers: [DynamicFrameFontService, DynamicFrameRendererService],
  exports: [DynamicFrameFontService, DynamicFrameRendererService],
})
export class DynamicRenderingModule {}
