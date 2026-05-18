import { Module } from '@nestjs/common';
import { ImageRendererService } from './image-renderer.service';
import { ImageRenderCacheService } from './image-render-cache.service';

@Module({
  providers: [ImageRendererService, ImageRenderCacheService],
  exports: [ImageRendererService, ImageRenderCacheService],
})
export class ImageRendererModule {}
