// 图片内容编辑页面 — 将路由参数解析后传入编辑器。

import { ImageContentEditor } from '@/features/contents/components/image-editor/ImageContentEditor';
import { ContentEditorPageLayout } from './ContentEditorPageLayout';

export function ImageContentEditorPage() {
  return (
    <ContentEditorPageLayout
      missingContentHint="请从内容列表进入图片内容编辑页。"
      notFoundTitle="内容不存在或已删除"
      findContent={(content) => content.kind === 'image'}
      renderEditor={({ gid, content, onDone }) => (
        <ImageContentEditor gid={gid} content={content} onDone={onDone} />
      )}
    />
  );
}
