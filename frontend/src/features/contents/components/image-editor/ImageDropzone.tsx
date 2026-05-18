// Mono Press 图片 dropzone — 虚线框，0 圆角。

import { useDropzone } from 'react-dropzone';
import { ImagePlus } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ImageDropzoneProps {
  isEdit: boolean;
  imageFile: File | null;
  onPick: (f: File | null) => void;
}

export function ImageDropzone({ isEdit, imageFile, onPick }: ImageDropzoneProps) {
  const dz = useDropzone({
    onDrop: (files) => onPick(files[0] ?? null),
    accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] },
    maxFiles: 1,
  });

  return (
    <div
      {...dz.getRootProps()}
      className={cn(
        'border border-dashed transition-colors px-5 py-6 text-center cursor-pointer',
        dz.isDragActive ? 'border-ink bg-cream' : 'border-ink/50 hover:border-ink hover:bg-cream'
      )}
    >
      <input {...dz.getInputProps()} />
      <ImagePlus
        size={20}
        className={cn(
          'mx-auto mb-2 transition-colors',
          imageFile ? 'text-ink' : 'text-stone-light'
        )}
      />
      {imageFile ? (
        <>
          <p className="font-serif text-[14px] text-ink truncate">{imageFile.name}</p>
          <p className="font-sans text-[11px] text-stone mt-0.5">
            {(imageFile.size / 1024).toFixed(1)} KB · 点击换图
          </p>
        </>
      ) : isEdit ? (
        <p className="font-sans text-[13px] text-stone">拖一张图替换原图，不传则保留</p>
      ) : (
        <>
          <p className="font-sans text-[13px] text-stone">拖图至此或点击选择</p>
          <p className="font-sans text-[11px] text-stone-light mt-0.5">
            PNG / JPG / WEBP / GIF / BMP
          </p>
        </>
      )}
    </div>
  );
}
