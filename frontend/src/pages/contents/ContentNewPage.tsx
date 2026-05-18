// 新建帧页面 — 路由 /groups/:gid/contents/new
// 统一入口，支持图片 + 所有动态类型在同一页面切换。

import { useParams, useNavigate } from 'react-router-dom';
import { ContentCreateEditor } from '@/features/contents/components/ContentCreateEditor';

export function ContentNewPage() {
  const { gid } = useParams();
  const navigate = useNavigate();

  function onDone() {
    navigate(`/groups/${gid}`);
  }

  return <ContentCreateEditor gid={gid!} onDone={onDone} />;
}
