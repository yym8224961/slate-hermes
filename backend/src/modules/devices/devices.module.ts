import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ContentsModule } from '../contents/contents.module';
import { DeviceFirmwareService } from './device-firmware.service';
import { DeviceManagementService } from './device-management.service';
import { DeviceFirmwareController } from './device-firmware.controller';
import { DeviceManagementController } from './device-management.controller';
import { PairCodeService } from './pair-code.service';

@Module({
  imports: [GroupsModule, ContentsModule],
  controllers: [DeviceFirmwareController, DeviceManagementController],
  providers: [DeviceFirmwareService, DeviceManagementService, PairCodeService],
  exports: [DeviceFirmwareService, DeviceManagementService],
})
export class DevicesModule {}
