import { z } from 'zod';
import { DITHER_MODES } from '../dither.js';

// PATCH /groups/:gid/frames/:seq —— 单独改 caption。
// (multipart 端点不走这个 schema；它直接读 form 字段)
export const PatchFrameRequest = z.object({
  caption: z.string().max(64).nullable().optional(),
});
export type PatchFrameRequestT = z.infer<typeof PatchFrameRequest>;

// PUT /groups/:gid/frames/order —— 批量重排，order = 旧 sort_order 列表的新顺序。
export const ReorderFramesRequest = z.object({
  order: z.array(z.number().int().nonnegative()).min(1),
});
export type ReorderFramesRequestT = z.infer<typeof ReorderFramesRequest>;

export const FrameSummary = z.object({
  sort_order: z.number().int().nonnegative(),
  caption: z.string().nullable(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  image_size: z.number().int().nonnegative(),
  audio_size: z.number().int().nonnegative().nullable(),
});
export type FrameSummaryT = z.infer<typeof FrameSummary>;

// 单帧上传/修改后的统一返回。group_etag 让客户端立即能展示新版本号。
export const FrameMutationResponse = z.object({
  sort_order: z.number().int().nonnegative(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  group_etag: z.string(),
});
export type FrameMutationResponseT = z.infer<typeof FrameMutationResponse>;

// GET /groups/:gid/manifest 返回的清单。
export const ManifestResponse = z.object({
  group_id: z.string(),
  group_etag: z.string(),
  frames: z.array(FrameSummary),
  default_frame_seq: z.number().int().nonnegative().default(0),
});
export type ManifestResponseT = z.infer<typeof ManifestResponse>;

// POST /groups/:gid/frames/:seq/render
//   用 JWT 把渲染好的内容推到指定帧。
export const RenderFrameRequest = z.object({
  source: z.enum(['markdown', 'html', 'png_base64']),
  content: z.string(),
  threshold: z.number().int().min(0).max(255).optional(),
  /** 抖动模式;不传 = 'threshold'(向后兼容) */
  mode: z.enum(DITHER_MODES).optional(),
});
export type RenderFrameRequestT = z.infer<typeof RenderFrameRequest>;
