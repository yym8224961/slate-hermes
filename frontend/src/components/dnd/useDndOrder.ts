// 拖拽重排公共逻辑 — Groups / GroupDetail / 内容网格 都用这个 hook。
//
// 用法:
//   const { sensors, currentOrder, orderedItems, onDragEnd } = useDndOrder(
//     items,
//     (id) => id,            // 取拖拽 id 的函数(默认就是 String(item))
//     (newOrder, { commit, rollback }) =>
//       mutate({ order: newOrder }, { onSuccess: commit, onError: rollback }),
//   );
//
// 本地只负责拖拽后的即时顺序和失败回滚；最终顺序由调用方 mutation 后 invalidate 的
// React Query 数据回填。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

interface PersistControls {
  commit: () => void;
  rollback: () => void;
}

export function useDndOrder<T>(
  items: T[] | undefined,
  getId: (item: T) => string,
  onPersist: (newOrder: string[], controls: PersistControls) => void
) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [currentOrder, setCurrentOrderState] = useState<string[]>([]);
  const currentOrderRef = useRef<string[]>([]);
  const persistSeqRef = useRef(0);

  const setCurrentOrder = useCallback((resolved: string[]) => {
    currentOrderRef.current = resolved;
    setCurrentOrderState(resolved);
  }, []);

  useEffect(() => {
    setCurrentOrder(items?.map(getId) ?? []);
  }, [getId, items, setCurrentOrder]);

  const orderedItems = useMemo(() => {
    const itemMap = new Map((items ?? []).map((item) => [getId(item), item]));
    const ordered = currentOrder
      .map((id) => itemMap.get(id))
      .filter((item): item is T => item !== undefined);
    const seen = new Set(ordered.map(getId));
    for (const item of items ?? []) {
      if (!seen.has(getId(item))) ordered.push(item);
    }
    return ordered;
  }, [currentOrder, getId, items]);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const order = currentOrderRef.current;
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldPos = order.indexOf(active.id as string);
      const newPos = order.indexOf(over.id as string);
      if (oldPos < 0 || newPos < 0) return;
      const previousOrder = [...order];
      const newOrder = arrayMove(order, oldPos, newPos);
      const persistSeq = ++persistSeqRef.current;
      setCurrentOrder(newOrder);
      onPersist(newOrder, {
        commit: () => {
          if (persistSeq === persistSeqRef.current) setCurrentOrder(newOrder);
        },
        rollback: () => {
          if (persistSeq === persistSeqRef.current) setCurrentOrder(previousOrder);
        },
      });
    },
    [onPersist, setCurrentOrder]
  );

  return { sensors, currentOrder, orderedItems, setCurrentOrder, onDragEnd };
}
