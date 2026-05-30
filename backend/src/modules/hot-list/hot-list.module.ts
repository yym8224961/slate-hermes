import { Module } from '@nestjs/common';
import { HotListProvider } from './hot-list.provider';

@Module({
  providers: [HotListProvider],
  exports: [HotListProvider],
})
export class HotListModule {}
