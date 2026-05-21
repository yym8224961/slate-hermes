import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ContentsModule } from '../contents/contents.module';
import { DevicesService } from './devices.service';
import { DevicesProtocolController } from './devices-protocol.controller';
import { DevicesAdminController } from './devices-admin.controller';

@Module({
  imports: [GroupsModule, ContentsModule],
  controllers: [DevicesProtocolController, DevicesAdminController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
