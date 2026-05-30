import { useCallback, useEffect, useRef, useState } from 'react';

interface CanvasOffset {
  x: number;
  y: number;
}

export function useCanvasPan({
  enabled,
  offset,
  currentOffsetRef,
  onOffsetChange,
  onPreviewMove,
  onCommit,
}: {
  enabled: boolean;
  offset: CanvasOffset;
  currentOffsetRef: React.MutableRefObject<CanvasOffset>;
  onOffsetChange: (o: CanvasOffset) => void;
  onPreviewMove: () => void;
  onCommit: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );

  useEffect(() => {
    if (!isDraggingRef.current) currentOffsetRef.current = offset;
  }, [currentOffsetRef, offset]);

  useEffect(() => {
    if (enabled) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    dragStartRef.current = null;
    currentOffsetRef.current = offset;
  }, [currentOffsetRef, enabled, offset]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      isDraggingRef.current = true;
      setIsDragging(true);
      currentOffsetRef.current = offset;
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [currentOffsetRef, enabled, offset]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      currentOffsetRef.current = {
        x: dragStartRef.current.offsetX + (event.clientX - dragStartRef.current.x),
        y: dragStartRef.current.offsetY + (event.clientY - dragStartRef.current.y),
      };
      onPreviewMove();
    },
    [currentOffsetRef, onPreviewMove]
  );

  const onPointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    dragStartRef.current = null;
    onOffsetChange(currentOffsetRef.current);
    onCommit();
  }, [currentOffsetRef, onCommit, onOffsetChange]);

  return {
    isDragging,
    isDraggingRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
