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
  reorder(@CurrentUser() user: WebUserContext, @Body() body: ReorderGroupsDto): Promise<void> {
    return this.groups.reorderGroups(user.userId, body.order);
  }

  @Get(':groupId')
  getOne(
    @CurrentUser() user: WebUserContext,
    @Param('groupId') groupId: string
  ): Promise<GroupSummaryT> {
    return this.groups.getOwned(groupId, user.userId);
  }

  @Patch(':groupId')
  patch(
    @CurrentUser() user: WebUserContext,
    @Param('groupId') groupId: string,
    @Body() body: UpdateGroupDto
  ): Promise<GroupSummaryT> {
    return this.groups.update(groupId, user.userId, body);
  }

  @Delete(':groupId')
  @HttpCode(204)
  delete(@CurrentUser() user: WebUserContext, @Param('groupId') groupId: string): Promise<void> {
    return this.groups.delete(groupId, user.userId);
  }
}
