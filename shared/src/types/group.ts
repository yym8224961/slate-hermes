import { z } from 'zod';

export const GroupSummary = z.object({
  id: z.string(),
  name: z.string(),
  etag: z.string(),
  sort_order: z.number().int(),
  content_count: z.number().int().nonnegative(),
  /** 所有内容的 image_size + audio_size 总和(字节)。
   *  约等于设备拉到本地后占用的存储,manifest JSON 不计。 */
  total_bytes: z.number().int().nonnegative(),
});
export type GroupSummaryT = z.infer<typeof GroupSummary>;

export const CreateGroupRequest = z.object({
  name: z.string().min(1).max(64),
});
export type CreateGroupRequestT = z.infer<typeof CreateGroupRequest>;

export const UpdateGroupRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  sort_order: z.number().int().optional(),
});
export type UpdateGroupRequestT = z.infer<typeof UpdateGroupRequest>;

// PUT /api/v1/groups/order —— 批量改 sort_order,order = 新 group_id 顺序。
export const ReorderGroupsRequest = z.object({
  order: z.array(z.string()).min(1),
});
export type ReorderGroupsRequestT = z.infer<typeof ReorderGroupsRequest>;
