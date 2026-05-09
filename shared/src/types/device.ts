import { z } from 'zod';

export const MacAddress = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'invalid MAC address')
  .transform((s) => s.toUpperCase().replace(/-/g, ':'));

// poll 响应里的 group 子对象。null = 还没选组。
export const DeviceStateGroup = z.object({
  id: z.string(),
  etag: z.string(),
  frame_count: z.number().int().nonnegative(),
  default_frame_seq: z.number().int().nonnegative(),
  sort_order: z.number().int(),
  position: z.object({
    current: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
});
export type DeviceStateGroupT = z.infer<typeof DeviceStateGroup>;

// poll 响应（无 reboot/action 队列）。
export const DeviceState = z.object({
  device: z.object({
    id: z.string(),
    mac: z.string(),
    name: z.string().nullable(),
    server_time: z.string().datetime(),
  }),
  group: DeviceStateGroup.nullable(),
  poll_interval_s: z.number().int().positive(),
});
export type DeviceStateT = z.infer<typeof DeviceState>;

// 单一 poll 端点的请求体：可选 telemetry。
export const PollRequest = z.object({
  telemetry: z
    .object({
      battery_pct: z.number().int().min(0).max(100).optional(),
      rssi_dbm: z.number().int().optional(),
      fw_version: z.string().max(32).optional(),
      current_group: z.string().nullable().optional(),
      current_frame_seq: z.number().int().nonnegative().optional(),
      free_heap: z.number().int().nonnegative().optional(),
      fw_build_ts: z.string().max(32).optional(),
    })
    .optional(),
});
export type PollRequestT = z.infer<typeof PollRequest>;

// 设备选指定组：PUT /api/v1/me/group  body: {id}
export const SelectGroupByDeviceRequest = z.object({
  id: z.string(),
});
export type SelectGroupByDeviceRequestT = z.infer<typeof SelectGroupByDeviceRequest>;

// POST /api/v1/me/group/next | /prev — direction 入 path，无 body。
export const CycleDirection = z.enum(['next', 'prev']);
export type CycleDirectionT = z.infer<typeof CycleDirection>;

// 注册端点：首次/重启都调，幂等。
export const RegisterDeviceRequest = z.object({
  mac: MacAddress,
  name: z.string().min(1).max(64).optional(),
});
export type RegisterDeviceRequestT = z.infer<typeof RegisterDeviceRequest>;

export const RegisterDeviceResponse = z.object({
  device_id: z.string(),
  mac: z.string(),
  reclaimed: z.boolean().optional(),
  server_time: z.string().datetime(),
});
export type RegisterDeviceResponseT = z.infer<typeof RegisterDeviceResponse>;

export const PatchDeviceRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  selected_group_id: z.string().nullable().optional(),
});
export type PatchDeviceRequestT = z.infer<typeof PatchDeviceRequest>;

export const ClaimByMacRequest = z.object({
  mac: MacAddress,
  name: z.string().min(1).max(64).optional(),
});
export type ClaimByMacRequestT = z.infer<typeof ClaimByMacRequest>;

export const ReorderDevicesRequest = z.object({
  order: z.array(z.string()).min(1),
});
export type ReorderDevicesRequestT = z.infer<typeof ReorderDevicesRequest>;

export const DeviceSummary = z.object({
  id: z.string(),
  mac: z.string(),
  name: z.string().nullable(),
  selected_group_id: z.string().nullable(),
  last_seen_at: z.string().datetime().nullable(),
  battery_pct: z.number().int().nullable(),
  rssi_dbm: z.number().int().nullable(),
  fw_version: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  sort_order: z.number().int(),
});
export type DeviceSummaryT = z.infer<typeof DeviceSummary>;
