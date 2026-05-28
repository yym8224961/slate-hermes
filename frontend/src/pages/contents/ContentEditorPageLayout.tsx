import { useCallback, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ContentDetailT } from 'shared';
import { useGroupContents } from '@/features/contents/queries';
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
  const contents = useGroupContents(gid);

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

  const content = contents.data?.find((item) => findContent(item, contentId));

  if (!content) {
    if (contents.isFetching) {
      return (
        <div className="pt-16 text-center">
          <Spinner label="加载中" />
        </div>
      );
    }
    return <EmptyState title={notFoundTitle} />;
  }

  return <>{renderEditor({ gid, content, onDone })}</>;
}
