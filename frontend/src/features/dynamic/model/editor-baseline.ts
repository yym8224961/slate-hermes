import type { DynamicConfigT, DynamicTypeT } from 'shared';
import { defaultFrameName } from '@/features/contents/model/frame-name';
import { canonicalJsonKey } from '@/lib/json';

export interface DynamicEditorBaseline {
  contentId: string;
  type: DynamicTypeT;
  frameName: string;
  configKey: string;
}

export function createDynamicEditorBaseline(
  contentId: string,
  type: DynamicTypeT,
  frameName: string | null,
  config: DynamicConfigT
): DynamicEditorBaseline {
  return {
    contentId,
    type,
    frameName: frameName ?? defaultFrameName(type, config),
    configKey: canonicalJsonKey(config),
  };
}

export function isSameDynamicEditorBaseline(
  a: DynamicEditorBaseline,
  b: DynamicEditorBaseline
): boolean {
  return (
    a.contentId === b.contentId &&
    a.type === b.type &&
    a.frameName === b.frameName &&
    a.configKey === b.configKey
  );
}
