import { Fragment, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/cn';

interface SortableGridProps<T> {
  sensors: SensorDescriptor<SensorOptions>[];
  order: string[];
  items: T[];
  onDragEnd: (event: DragEndEvent) => void;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
}

export function SortableGrid<T>({
  sensors,
  order,
  items,
  onDragEnd,
  getKey,
  renderItem,
  className,
}: SortableGridProps<T>) {
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <div className={cn('grid', className)}>
          {items.map((item) => (
            <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
