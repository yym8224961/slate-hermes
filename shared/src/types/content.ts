import { z } from 'zod';
import { DITHER_MODES } from '../dither.js';
import { DynamicConfig, DynamicType } from './dynamic.js';

export const ContentKind = z.enum(['image', 'dynamic']);
export type ContentKindT = z.infer<typeof ContentKind>;

export const PatchContentRequest = z.object({
  title: z.string().max(64).nullable().optional(),
});
export type PatchContentRequestT = z.infer<typeof PatchContentRequest>;

export const ReorderContentsRequest = z.object({
  order: z.array(z.string().min(1)).min(1),
});
export type ReorderContentsRequestT = z.infer<typeof ReorderContentsRequest>;

export const ContentSummary = z.object({
  content_id: z.string(),
  seq: z.number().int().nonnegative(),
  title: z.string().nullable(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  image_size: z.number().int().nonnegative(),
  audio_size: z.number().int().nonnegative().nullable(),
  kind: ContentKind,
  dynamic_type: z.string().nullable(),
  next_wake_sec: z.number().int().nonnegative().nullable(),
});
export type ContentSummaryT = z.infer<typeof ContentSummary>;

export const ContentDetail = ContentSummary.extend({
  group_id: z.string(),
  dynamic_config: z.unknown().nullable(),
  dynamic_data: z.unknown().nullable(),
  dynamic_last_rendered_at: z.string().datetime().nullable(),
  dynamic_next_render_at: z.string().datetime().nullable(),
  dynamic_render_error: z.string().nullable(),
});
export type ContentDetailT = z.infer<typeof ContentDetail>;

export const ContentMutationResponse = z.object({
  content_id: z.string(),
  seq: z.number().int().nonnegative(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  group_etag: z.string(),
});
export type ContentMutationResponseT = z.infer<typeof ContentMutationResponse>;

export const CreateDynamicContentRequest = z.object({
  kind: z.literal('dynamic'),
  dynamic_type: DynamicType,
  config: DynamicConfig,
  title: z.string().max(64).nullable().optional(),
});
export type CreateDynamicContentRequestT = z.infer<typeof CreateDynamicContentRequest>;

export const PatchDynamicContentRequest = z.object({
  title: z.string().max(64).nullable().optional(),
  config: DynamicConfig.optional(),
});
export type PatchDynamicContentRequestT = z.infer<typeof PatchDynamicContentRequest>;

export const DynamicConfigResponse = z.object({
  dynamic_type: DynamicType,
  config: DynamicConfig,
  title: z.string().nullable(),
});
export type DynamicConfigResponseT = z.infer<typeof DynamicConfigResponse>;

export const PreviewDynamicContentRequest = z.object({
  dynamic_type: DynamicType,
  config: DynamicConfig,
  title: z.string().max(64).nullable().optional(),
});
export type PreviewDynamicContentRequestT = z.infer<typeof PreviewDynamicContentRequest>;

export const ManifestResponse = z.object({
  group: z.object({
    id: z.string(),
    etag: z.string(),
    name: z.string(),
    sort_order: z.number().int(),
    position: z.object({
      current: z.number().int().positive(),
      total: z.number().int().positive(),
    }),
  }),
  contents: z.array(ContentSummary),
});
export type ManifestResponseT = z.infer<typeof ManifestResponse>;

export const RenderContentRequest = z.object({
  source: z.enum(['markdown', 'html', 'png_base64']),
  content: z.string(),
  threshold: z.number().int().min(0).max(255).optional(),
  mode: z.enum(DITHER_MODES).optional(),
});
export type RenderContentRequestT = z.infer<typeof RenderContentRequest>;
