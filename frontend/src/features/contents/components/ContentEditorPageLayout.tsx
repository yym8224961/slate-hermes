import { useCallback, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ContentDetailT } from 'shared';
import { useContentDetail } from '@/features/contents/queries';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';

interface ContentEditorPageLayoutProps {
  missingContentHint: string;
  notFoundTitle: string;
  findContent: (content: ContentDetailT, contentId: string) => boolean;
  renderEditor: (props: { gid: string; content: ContentDetailT; onDone: () => void }) => ReactNode;
}

export function ContentEditorPageLayout({
  missingContentHint,
  notFoundTitle,
  findContent,
  renderEditor,
}: ContentEditorPageLayoutProps) {
  const { gid, contentId } = useParams();
  const navigate = useNavigate();
  const content = useContentDetail(gid && contentId ? contentId : undefined);

  const onDone = useCallback(() => {
    if (!gid) return;
    navigate(`/groups/${gid}`);
  }, [gid, navigate]);

  if (!gid) {
    return <EmptyState title="页面不存在" hint="请从总览页进入具体内容组。" />;
  }

  if (!contentId) {
    return <EmptyState title="页面不存在" hint={missingContentHint} />;
  }

  if (content.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }

  if (content.isError) {
    return <EmptyState title="加载失败" hint="请刷新重试。" />;
  }

  const isExpectedContent = content.data ? findContent(content.data, contentId) : false;

  if (!content.data || !isExpectedContent || content.data.group_id !== gid) {
    if (content.isFetching) {
      return (
        <div className="pt-16 text-center">
          <Spinner label="加载中" />
        </div>
      );
    }
    return <EmptyState title={notFoundTitle} />;
  }

  return <>{renderEditor({ gid, content: content.data, onDone })}</>;
}
