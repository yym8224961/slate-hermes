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
// 状态保留在本地以避免 React Query optimistic 更新与 dnd-kit 时序混乱。
//
// 并发权衡：服务器在 mutation 完成前回了「成员一致但顺序不同」的快照（比如别人
// 同时改了序），本 hook 会优先保留本地 pendingOrder，直到我们这次的 mutation
// 也成功（serverOrder === pendingOrder）才接管。代价是别人的并发改动会延迟到
// 本次结束之后才显现，换的是拖拽过程的视觉稳定。

import { useEffect, useMemo, useRef, useState } from 'react';
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

  const [currentOrder, setCurrentOrder] = useState<string[]>([]);
  const latestPersistSeqRef = useRef(0);
  const pendingOrderRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!items) {
      pendingOrderRef.current = null;
      setCurrentOrder([]);
      return;
    }
    const serverOrder = items.map(getId);
    const pendingOrder = pendingOrderRef.current;
    if (pendingOrder && sameOrder(serverOrder, pendingOrder)) {
      pendingOrderRef.current = null;
      setCurrentOrder(serverOrder);
      return;
    }
    if (pendingOrder && sameOrderMembers(serverOrder, pendingOrder)) {
      setCurrentOrder(pendingOrder);
      return;
    }
    pendingOrderRef.current = null;
    setCurrentOrder(serverOrder);
  }, [getId, items]);

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

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldPos = currentOrder.indexOf(active.id as string);
    const newPos = currentOrder.indexOf(over.id as string);
    if (oldPos < 0 || newPos < 0) return;
    const persistSeq = ++latestPersistSeqRef.current;
    const previousOrder = [...currentOrder];
    const newOrder = arrayMove(currentOrder, oldPos, newPos);
    pendingOrderRef.current = newOrder;
    setCurrentOrder(newOrder);
    const finishIfCurrent = (fn: () => void) => {
      if (persistSeq !== latestPersistSeqRef.current) return;
      pendingOrderRef.current = null;
      fn();
    };
    onPersist(newOrder, {
      commit: () => finishIfCurrent(() => setCurrentOrder(newOrder)),
      rollback: () =>
        finishIfCurrent(() =>
          setCurrentOrder((current) => (sameOrder(current, newOrder) ? previousOrder : current))
        ),
    });
  }

  return { sensors, currentOrder, orderedItems, setCurrentOrder, onDragEnd };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

function sameOrderMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((id) => members.has(id));
}
