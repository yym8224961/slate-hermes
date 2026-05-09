import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import type { GroupSummaryT } from 'shared';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { GroupsService } from './groups.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { ReorderGroupsDto } from './dto/reorder-groups.dto';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() user: WebUserContext): Promise<GroupSummaryT[]> {
    return this.groups.listForOwner(user.userId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: WebUserContext,
    @Body() body: CreateGroupDto
  ): Promise<GroupSummaryT> {
    return this.groups.create(user.userId, body);
  }

  // 必须放在 /:gid 之前
  @Put('order')
  @HttpCode(204)
  async reorder(
    @CurrentUser() user: WebUserContext,
    @Body() body: ReorderGroupsDto
  ): Promise<void> {
    await this.groups.reorderGroups(user.userId, body.order);
  }

  @Get(':gid')
  getOne(@CurrentUser() user: WebUserContext, @Param('gid') gid: string): Promise<GroupSummaryT> {
    return this.groups.getOwned(gid, user.userId);
  }

  @Patch(':gid')
  @HttpCode(204)
  async patch(
    @CurrentUser() user: WebUserContext,
    @Param('gid') gid: string,
    @Body() body: UpdateGroupDto
  ): Promise<void> {
    await this.groups.update(gid, user.userId, body);
  }

  @Delete(':gid')
  @HttpCode(204)
  async delete(@CurrentUser() user: WebUserContext, @Param('gid') gid: string): Promise<void> {
    await this.groups.delete(gid, user.userId);
  }
}
