import { Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

interface ContentCardActionsProps {
  dragHandle: ReactNode;
  extraActions?: ReactNode;
  audioPreview?: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  deleteDisabled?: boolean;
}

export function ContentCardActions({
  dragHandle,
  extraActions,
  audioPreview,
  onEdit,
  onDelete,
  deleteDisabled,
}: ContentCardActionsProps) {
  return (
    <>
      {dragHandle}
      {extraActions}
      {audioPreview}

      <span className="flex-1" />

      <button
        type="button"
        onClick={onEdit}
        aria-label="编辑"
        title="编辑"
        className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors"
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleteDisabled}
        aria-label="删除"
        title="删除"
        className="p-1.5 text-stone hover:text-clay hover:bg-cream transition-colors disabled:opacity-50"
      >
        <Trash2 size={14} />
      </button>
    </>
  );
}
