// 动态内容编辑页 —— create + edit 共用。
//
// 路由：
//   /groups/:gid/contents/dynamic/:contentId/edit — 编辑

import { useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useGroupContents } from '@/features/contents/queries';
import { DynamicContentEditor } from '@/features/dynamic/components/DynamicContentEditor';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

export function DynamicContentEditorPage() {
  const { gid, contentId } = useParams();
  const navigate = useNavigate();
  const contents = useGroupContents(gid);

  const onDone = useCallback(() => {
    if (!gid) return;
    navigate(`/groups/${gid}`);
  }, [gid, navigate]);

  if (!gid) {
    return <EmptyState title="页面不存在" hint="请从总览页进入具体内容组。" />;
  }

  if (!contentId) {
    return (
      <EmptyState
        title="页面不存在"
        hint="请从内容列表进入动态内容编辑页。"
        action={
          <Button variant="outline" size="sm" onClick={onDone}>
            返回
          </Button>
        }
      />
    );
  }

  if (contents.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }

  if (contents.isError) {
    return <EmptyState title="加载失败" hint="请刷新重试。" />;
  }

  const content = contents.data?.find((f) => f.id === contentId && f.kind === 'dynamic');
  if (!content) {
    return <EmptyState title="动态内容不存在或已删除" />;
  }
  if (!content.dynamic_type || !content.dynamic_config) {
    return (
      <EmptyState
        title="动态内容配置缺失"
        hint="这条动态内容的数据不完整，请返回内容列表后重试。"
        action={
          <Button variant="outline" size="sm" onClick={onDone}>
            返回
          </Button>
        }
      />
    );
  }
  const initialType = content.dynamic_type;
  const initialConfig = content.dynamic_config;

  // ContentDetail 已经带 dynamic_type / dynamic_config，省一次 GET /contents/:id 请求。
  return (
    <DynamicContentEditor
      gid={gid}
      content={content}
      initialType={initialType}
      initialConfig={initialConfig}
      onDone={onDone}
    />
  );
}
