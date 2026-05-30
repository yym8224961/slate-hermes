import { useCallback, useState } from 'react';

export interface CropOffset {
  x: number;
  y: number;
}

export function useCropState() {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 });

  const resetCrop = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  return { scale, setScale, offset, setOffset, resetCrop };
}
