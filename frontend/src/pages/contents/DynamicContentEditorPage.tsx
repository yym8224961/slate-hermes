// 动态内容编辑页 —— create + edit 共用。
//
// 路由：
//   /groups/:gid/contents/dynamic/:contentId/edit — 编辑

import { useParams, useNavigate } from 'react-router-dom';
import { useGroupContents } from '@/features/contents/queries';
import { DynamicContentEditor } from '@/features/dynamic-content/components/DynamicContentEditor';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';

export function DynamicContentEditorPage() {
  const { gid, contentId } = useParams();
  const navigate = useNavigate();
  const isEdit = !!contentId;
  const contents = useGroupContents(gid);

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
    ? contents.data?.find((f) => f.id === contentId && f.kind === 'dynamic')
    : undefined;
  if (isEdit && !content) {
    return <EmptyState title="动态内容不存在或已删除" />;
  }
  if (!content?.dynamic_type || !content.dynamic_config) {
    return <EmptyState title="动态内容配置缺失" hint="请返回内容列表后重试。" />;
  }

  // ContentDetail 已经带 dynamic_type / dynamic_config，省一次 GET /contents/:id 请求。
  return (
    <DynamicContentEditor
      gid={gid}
      content={content}
      initialType={content.dynamic_type}
      initialConfig={content.dynamic_config}
      onDone={onDone}
    />
  );
}
