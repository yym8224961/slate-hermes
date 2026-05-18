// 动态内容编辑页 —— create + edit 共用。
//
// 路由：
//   /groups/:gid/contents/dynamic/:contentId/edit — 编辑

import { useParams, useNavigate } from 'react-router-dom';
import { useDynamicConfig, useGroupContents } from '@/features/contents/queries';
import { DynamicContentEditor } from '@/features/dynamic-content/components/DynamicContentEditor';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { DynamicTypeT } from 'shared';

export function DynamicContentEditorPage() {
  const { gid, contentId } = useParams();
  const navigate = useNavigate();
  const isEdit = !!contentId;
  const contents = useGroupContents(gid);
  const cfg = useDynamicConfig(contentId);

  function onDone() {
    navigate(`/groups/${gid}`);
  }

  if (isEdit && (contents.isPending || cfg.isPending)) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }

  if (isEdit && (contents.isError || cfg.isError)) {
    return <EmptyState title="加载失败" hint="请刷新重试。" />;
  }

  const content = isEdit ? contents.data?.find((f) => f.content_id === contentId) : undefined;
  if (isEdit && !content) {
    return <EmptyState title="动态内容不存在或已删除" />;
  }

  return (
    <DynamicContentEditor
      gid={gid!}
      content={content}
      initialType={isEdit ? (cfg.data?.dynamic_type as DynamicTypeT) : undefined}
      initialConfig={isEdit ? cfg.data?.config : undefined}
      onDone={onDone}
    />
  );
}
