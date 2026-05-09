// 拖拽重排公共逻辑 — Groups / GroupDetail / 帧网格 都用这个 hook。
//
// 用法:
//   const { sensors, currentOrder, onDragEnd } = useDndOrder(
//     items,
//     (id) => id,            // 取拖拽 id 的函数(默认就是 String(item))
//     (newOrder) => mutate({ order: newOrder }),
//   );
//
// 状态保留在本地以避免 React Query optimistic 更新与 dnd-kit 拍号混乱。
//
// items 变化（数据库刷新）时，如果「自己刚拖完」，useEffect 会重新对齐 currentOrder。

import { useEffect, useState } from 'react';
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

export function useDndOrder<T>(
  items: T[] | undefined,
  getId: (item: T) => string,
  onPersist: (newOrder: string[]) => void
) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [currentOrder, setCurrentOrder] = useState<string[]>([]);

  useEffect(() => {
    if (items) setCurrentOrder(items.map(getId));
    // getId 由调用方稳定提供
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldPos = currentOrder.indexOf(active.id as string);
    const newPos = currentOrder.indexOf(over.id as string);
    if (oldPos < 0 || newPos < 0) return;
    const newOrder = arrayMove(currentOrder, oldPos, newPos);
    setCurrentOrder(newOrder);
    onPersist(newOrder);
  }

  return { sensors, currentOrder, setCurrentOrder, onDragEnd };
}
