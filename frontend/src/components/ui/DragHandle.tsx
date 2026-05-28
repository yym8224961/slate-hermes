import { GripVertical } from 'lucide-react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';

interface DragHandleProps {
  attributes: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  label?: string;
}

export function DragHandle({ attributes, listeners, label = '拖拽排序' }: DragHandleProps) {
  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={label}
      title={label}
      className="p-1.5 text-stone-light hover:text-ink hover:bg-cream transition-colors cursor-grab active:cursor-grabbing touch-none"
    >
      <GripVertical size={14} />
    </button>
  );
}
