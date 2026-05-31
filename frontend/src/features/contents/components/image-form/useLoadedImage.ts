import { useEffect, useState } from 'react';

export interface LoadedImage {
  file: File;
  image: HTMLImageElement;
}

export function useLoadedImage(imageFile: File | null): LoadedImage | null {
  const [loadedImage, setLoadedImage] = useState<LoadedImage | null>(null);

  useEffect(() => {
    if (!imageFile) {
      setLoadedImage(null);
      return;
    }

    const url = URL.createObjectURL(imageFile);
    let cancelled = false;
    let revoked = false;
    const revoke = () => {
      if (!revoked) {
        URL.revokeObjectURL(url);
        revoked = true;
      }
    };
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoadedImage({ file: imageFile, image: img });
      revoke();
    };
    img.onerror = () => {
      if (!cancelled) setLoadedImage(null);
      revoke();
    };
    img.src = url;
    return () => {
      cancelled = true;
      revoke();
    };
  }, [imageFile]);

  return loadedImage;
}
