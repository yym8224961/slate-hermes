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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface PersistControls {
  commit: () => void;
  rollback: () => void;
}

interface DndRuntimeState {
  latestItemsOrder: string[];
  persistSeq: number;
  pendingOrder: string[] | null;
}

export function useDndOrder<T>(
  items: T[] | undefined,
  getId: (item: T) => string,
  onPersist: (newOrder: string[], controls: PersistControls) => void
) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [currentOrder, setCurrentOrderState] = useState<string[]>([]);
  const currentOrderRef = useRef<string[]>([]);
  const runtimeRef = useRef<DndRuntimeState>({
    latestItemsOrder: [],
    persistSeq: 0,
    pendingOrder: null,
  });
  const getIdRef = useRef(getId);
  const onPersistRef = useRef(onPersist);

  const setCurrentOrder = useCallback((next: SetStateAction<string[]>) => {
    const resolved =
      typeof next === 'function'
        ? (next as (current: string[]) => string[])(currentOrderRef.current)
        : next;
    currentOrderRef.current = resolved;
    setCurrentOrderState(resolved);
  }, []);

  useEffect(() => {
    getIdRef.current = getId;
  }, [getId]);

  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    if (!items) {
      runtimeRef.current.latestItemsOrder = [];
      runtimeRef.current.pendingOrder = null;
      setCurrentOrder([]);
      return;
    }
    const serverOrder = items.map((item) => getIdRef.current(item));
    runtimeRef.current.latestItemsOrder = serverOrder;
    const pendingOrder = runtimeRef.current.pendingOrder;
    if (pendingOrder && sameOrder(serverOrder, pendingOrder)) {
      runtimeRef.current.pendingOrder = null;
      setCurrentOrder(serverOrder);
      return;
    }
    if (pendingOrder && sameOrderMembers(serverOrder, pendingOrder)) {
      setCurrentOrder(pendingOrder);
      return;
    }
    runtimeRef.current.pendingOrder = null;
    setCurrentOrder(serverOrder);
  }, [items, setCurrentOrder]);

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
      const persistSeq = ++runtimeRef.current.persistSeq;
      runtimeRef.current.pendingOrder = newOrder;
      setCurrentOrder(newOrder);
      onPersistRef.current(
        newOrder,
        createPersistControls({
          runtimeRef,
          persistSeq,
          previousOrder,
          newOrder,
          currentOrderRef,
          setCurrentOrder,
        })
      );
    },
    [setCurrentOrder]
  );

  return { sensors, currentOrder, orderedItems, setCurrentOrder, onDragEnd };
}

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

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

function sameOrderMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((id) => members.has(id));
}

function createPersistControls({
  runtimeRef,
  persistSeq,
  previousOrder,
  newOrder,
  currentOrderRef,
  setCurrentOrder,
}: {
  runtimeRef: MutableRefObject<DndRuntimeState>;
  persistSeq: number;
  previousOrder: string[];
  newOrder: string[];
  currentOrderRef: MutableRefObject<string[]>;
  setCurrentOrder: (next: SetStateAction<string[]>) => void;
}): PersistControls {
  const finishIfCurrent = (fn: (latestItemsOrder: string[]) => void) => {
    const runtime = runtimeRef.current;
    if (persistSeq !== runtime.persistSeq) return;
    runtime.pendingOrder = null;
    fn(runtime.latestItemsOrder);
  };

  return {
    commit: () =>
      finishIfCurrent((latestItemsOrder) => {
        if (!sameOrderMembers(latestItemsOrder, newOrder)) {
          setCurrentOrder(latestItemsOrder);
        } else if (!sameOrder(currentOrderRef.current, newOrder)) {
          setCurrentOrder(newOrder);
        }
      }),
    rollback: () =>
      finishIfCurrent((latestItemsOrder) => {
        setCurrentOrder((current) => {
          if (!sameOrderMembers(current, previousOrder)) return latestItemsOrder;
          return sameOrder(current, newOrder) ? previousOrder : current;
        });
      }),
  };
}
