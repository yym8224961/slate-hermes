import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { DeviceSummaryT } from 'shared';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { DevicesService } from './devices.service';
import { PatchDeviceDto } from './dto/patch-device.dto';
import { ClaimByPairCodeDto } from './dto/claim-by-pair-code.dto';
import { ReorderDevicesDto } from './dto/reorder-devices.dto';
import { ListDevicesQueryDto } from './dto/list-devices.dto';

@Controller('devices')
export class DevicesAdminController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  async list(
    @CurrentUser() user: WebUserContext,
    @Query() q: ListDevicesQueryDto
  ): Promise<DeviceSummaryT[]> {
    if (q.owner === 'none') return this.devices.listUnowned();
    return this.devices.listForOwner(user.userId);
  }

  // 必须挂在 /:id 之前，否则 "order" 会被 :id 接走
  @Put('order')
  @HttpCode(204)
  async reorder(
    @CurrentUser() user: WebUserContext,
    @Body() body: ReorderDevicesDto
  ): Promise<void> {
    await this.devices.reorderDevices(user.userId, body.order);
  }

  @Post('claim-by-pair-code')
  async claimByPairCode(
    @CurrentUser() user: WebUserContext,
    @Body() body: ClaimByPairCodeDto
  ): Promise<DeviceSummaryT> {
    return this.devices.claimByPairCode(body.code, user.userId);
  }

  @Get(':id')
  async getOne(
    @CurrentUser() user: WebUserContext,
    @Param('id') id: string
  ): Promise<DeviceSummaryT> {
    return this.devices.getOwned(id, user.userId);
  }

  @Patch(':id')
  @HttpCode(204)
  async patch(
    @CurrentUser() user: WebUserContext,
    @Param('id') id: string,
    @Body() body: PatchDeviceDto
  ): Promise<void> {
    await this.devices.patchDevice(id, user.userId, body);
  }

  // /:id/binding 命名表达"解绑(把设备从当前 owner 移除)"而非"删除设备记录"。
  // 设备记录本身不删,仍按 mac 在 DB 里;新主人用新 pair_code 即可重新 claim。
  @Delete(':id/binding')
  @HttpCode(204)
  async unbind(@CurrentUser() user: WebUserContext, @Param('id') id: string): Promise<void> {
    await this.devices.unbind(id, user.userId);
  }
}
