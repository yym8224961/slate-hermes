import { useMemo, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function useSortableStyle(id: string) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id,
    animateLayoutChanges: () => false,
  });
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition: 'none',
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transform]
  );
  return { attributes, listeners, setNodeRef, isDragging, style };
}
