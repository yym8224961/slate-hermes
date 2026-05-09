import { Module } from '@nestjs/common';
import { RenderService } from './render.service';
import { RenderCacheService } from './render-cache.service';

@Module({
  providers: [RenderService, RenderCacheService],
  exports: [RenderService, RenderCacheService],
})
export class RenderModule {}
