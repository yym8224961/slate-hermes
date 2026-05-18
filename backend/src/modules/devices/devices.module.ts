import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { DynamicContentModule } from '../dynamic-content/dynamic-content.module';
import { DevicesService } from './devices.service';
import { DevicesProtocolController } from './devices-protocol.controller';
import { DevicesAdminController } from './devices-admin.controller';

@Module({
  imports: [GroupsModule, DynamicContentModule],
  controllers: [DevicesProtocolController, DevicesAdminController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
