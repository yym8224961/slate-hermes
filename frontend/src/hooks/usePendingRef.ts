import { useLayoutEffect, useRef } from 'react';

export function usePendingRef(isPending: boolean) {
  const isPendingRef = useRef(isPending);
  useLayoutEffect(() => {
    isPendingRef.current = isPending;
  }, [isPending]);
  return isPendingRef;
}
