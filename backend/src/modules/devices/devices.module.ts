import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ContentsModule } from '../contents/contents.module';
import { DevicesService } from './devices.service';
import { DevicesProtocolController } from './devices-protocol.controller';
import { DevicesAdminController } from './devices-admin.controller';
import { DeviceRegisterRateLimitGuard } from './device-register-rate-limit.guard';
import { DeviceClaimRateLimitGuard } from './device-claim-rate-limit.guard';
import { PairCodeService } from './pair-code.service';

@Module({
  imports: [GroupsModule, ContentsModule],
  controllers: [DevicesProtocolController, DevicesAdminController],
  providers: [
    DevicesService,
    PairCodeService,
    DeviceRegisterRateLimitGuard,
    DeviceClaimRateLimitGuard,
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
