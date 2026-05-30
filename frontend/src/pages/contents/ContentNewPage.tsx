// 新建帧页面 — 路由 /groups/:gid/contents/new
// 统一入口，支持图片 + 所有动态类型在同一页面切换。

import { useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ContentCreateEditor } from '@/features/contents/components/create/ContentCreateEditor';
import { EmptyState } from '@/components/ui/EmptyState';

export function ContentNewPage() {
  const { gid } = useParams();
  const navigate = useNavigate();

  const onDone = useCallback(() => {
    if (!gid) return;
    navigate(`/groups/${gid}`);
  }, [gid, navigate]);

  const onEditCreatedImage = useCallback(
    (contentId: string) => {
      if (!gid) return;
      navigate(`/groups/${gid}/contents/image/${contentId}/edit`);
    },
    [gid, navigate]
  );

  if (!gid) {
    return <EmptyState title="页面不存在" hint="请从总览页进入具体内容组。" />;
  }

  return <ContentCreateEditor gid={gid} onDone={onDone} onEditCreatedImage={onEditCreatedImage} />;
}
