import { Body, Controller, Post, Put, UseGuards } from '@nestjs/common';
import type { DeviceStateT, RegisterDeviceResponseT } from 'shared';
import { Public } from '../../common/decorators/public.decorator';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import {
  CurrentDevice,
  type DeviceContext,
} from '../../common/decorators/current-device.decorator';
import { DevicesService } from './devices.service';
import { GroupsService } from '../groups/groups.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { PollDto } from './dto/poll.dto';
import { SelectGroupByDeviceDto } from './dto/select-group.dto';

@Controller()
export class DevicesProtocolController {
  constructor(
    private readonly devices: DevicesService,
    private readonly groups: GroupsService
  ) {}

  // ── register（无鉴权）────────────────────────────────────
  @Public()
  @Post('devices')
  async register(@Body() body: RegisterDeviceDto): Promise<RegisterDeviceResponseT> {
    const r = await this.devices.claimDevice(body.mac, body.name);
    return {
      device_id: r.deviceId,
      mac: body.mac,
      reclaimed: r.reclaimed,
      server_time: r.serverTime,
    };
  }

  // ── 以下 /me/* 都要 X-Device-Mac ───────────────────────
  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('me/poll')
  async poll(@CurrentDevice() dev: DeviceContext, @Body() body: PollDto): Promise<DeviceStateT> {
    await this.devices.recordTelemetry(dev.deviceId, body.telemetry);
    return this.devices.buildState(dev.deviceId);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Put('me/group')
  async selectGroup(
    @CurrentDevice() dev: DeviceContext,
    @Body() body: SelectGroupByDeviceDto
  ): Promise<DeviceStateT> {
    await this.groups.setDeviceGroup(dev.deviceId, body.id);
    return this.devices.buildState(dev.deviceId);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('me/group/next')
  async cycleNext(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'next');
    return this.devices.buildState(dev.deviceId, { group: result });
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('me/group/prev')
  async cyclePrev(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'prev');
    return this.devices.buildState(dev.deviceId, { group: result });
  }
}
