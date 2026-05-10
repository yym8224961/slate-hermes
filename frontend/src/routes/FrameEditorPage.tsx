import { useParams, useNavigate } from 'react-router-dom';
import { useGroupFrames } from '../lib/queries';
import { FrameEditor } from '../components/FrameEditor';
import { Spinner } from '../components/Spinner';
import { EmptyState } from '../components/EmptyState';

export function FrameEditorPage() {
  const { gid, seq } = useParams();
  const navigate = useNavigate();
  const frames = useGroupFrames(gid);
  const isEdit = seq !== undefined;

  function onDone() {
    navigate(`/groups/${gid}`);
  }

  if (isEdit && frames.isPending) {
    return (
      <div className="pt-16 text-center">
        <Spinner label="加载中" />
      </div>
    );
  }

  const frame = isEdit ? frames.data?.find((f) => f.sort_order === Number(seq)) : undefined;

  if (isEdit && !frame) {
    return <EmptyState title="帧不存在或已删除" />;
  }

  return <FrameEditor gid={gid!} frame={frame} onDone={onDone} />;
}
