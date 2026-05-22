// 图片内容编辑页面 — 将路由参数解析后传入编辑器，create / edit 两种模式共用。

import { useParams, useNavigate } from 'react-router-dom';
import { useGroupContents } from '@/features/contents/queries';
import { ImageContentEditor } from '@/features/contents/components/image-editor/ImageContentEditor';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';

export function ImageContentEditorPage() {
  const { gid, contentId } = useParams();
  const navigate = useNavigate();
  const contents = useGroupContents(gid);
  const isEdit = contentId !== undefined;

  if (!gid) {
    return <EmptyState title="页面不存在" hint="请从总览页进入具体内容组。" />;
  }

  function onDone() {
    navigate(`/groups/${gid}`);
  }

  if (isEdit && contents.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }

  if (isEdit && contents.isError) {
    return <EmptyState title="加载失败" hint="请刷新重试。" />;
  }

  const content = isEdit
    ? contents.data?.find((f) => f.id === contentId && f.kind === 'image')
    : undefined;

  if (isEdit && !content) {
    return <EmptyState title="内容不存在或已删除" />;
  }

  return <ImageContentEditor gid={gid} content={content} onDone={onDone} />;
}
