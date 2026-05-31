export interface DynamicRenderContext {
  type: string;
  frameName?: string | null;
  config: Record<string, unknown>;
  data: Record<string, unknown> | null;
  renderedAt: Date;
}
