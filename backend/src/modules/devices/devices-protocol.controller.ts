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
import { DynamicContentRefreshService } from '../dynamic-content/dynamic-content-refresh.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { PollDto } from './dto/poll.dto';
import { SelectGroupByDeviceDto } from './dto/select-group.dto';

@Controller()
export class DevicesProtocolController {
  constructor(
    private readonly devices: DevicesService,
    private readonly groups: GroupsService,
    private readonly dynamicContentRefresh: DynamicContentRefreshService
  ) {}

  // ── register / reset（无鉴权）────────────────────────────
  // 同 mac 二次进来一律走 reset 路径（清 owner、清相册、轮换 secret + pair_code），
  // 实现「物理重置即转移」语义。固件那侧只在 NVS 没 device_secret 时调用此端点。
  @Public()
  @Post('devices')
  async register(@Body() body: RegisterDeviceDto): Promise<RegisterDeviceResponseT> {
    const r = await this.devices.registerOrReset(body.mac);
    return {
      id: r.deviceId,
      mac: body.mac,
      device_secret: r.deviceSecret,
      pair_code: r.pairCode,
      reclaimed: r.reclaimed,
      server_time: r.serverTime,
    };
  }

  // ── 以下 /devices/current/* 都要 Authorization: Bearer <device_secret> ───
  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/poll')
  async poll(@CurrentDevice() dev: DeviceContext, @Body() body: PollDto): Promise<DeviceStateT> {
    await this.devices.recordTelemetry(dev.deviceId, body.telemetry);
    if (body.telemetry?.current_group && body.telemetry.current_content_seq !== undefined) {
      await this.dynamicContentRefresh.refreshDeviceCurrentFrame(dev.deviceId, body.telemetry);
    }
    return this.devices.buildState(dev.deviceId);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Put('devices/current/group')
  async selectGroup(
    @CurrentDevice() dev: DeviceContext,
    @Body() body: SelectGroupByDeviceDto
  ): Promise<DeviceStateT> {
    await this.groups.setDeviceGroup(dev.deviceId, body.id);
    return this.devices.buildState(dev.deviceId);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/group/next')
  async cycleNext(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'next');
    return this.devices.buildState(dev.deviceId, { group: result });
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/group/prev')
  async cyclePrev(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'prev');
    return this.devices.buildState(dev.deviceId, { group: result });
  }
}
