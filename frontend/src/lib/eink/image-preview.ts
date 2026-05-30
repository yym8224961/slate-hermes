import { autoContrast, autoInvert, ditherToBinary, rgbaToGray, type DitherMode } from 'shared';
import { clearCanvas } from './bpp';
import { INK_RGB, PAPER_RGB } from './colors';

export function drawImagePreview(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  {
    scale,
    offset,
    threshold,
    mode,
    dither,
  }: {
    scale: number;
    offset: { x: number; y: number };
    threshold: number;
    mode: DitherMode;
    dither: boolean;
  }
) {
  clearCanvas(ctx, canvas);

  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const baseScale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const finalScale = baseScale * scale;
  const drawW = sourceWidth * finalScale;
  const drawH = sourceHeight * finalScale;
  const drawX = (canvas.width - drawW) / 2 + offset.x;
  const drawY = (canvas.height - drawH) / 2 + offset.y;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  if (!dither) return;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let gray = rgbaToGray(imageData.data, canvas.width, canvas.height, 4);
  gray = autoInvert(gray, canvas.width, canvas.height);
  gray = autoContrast(gray, 1);
  const bin = ditherToBinary(gray, canvas.width, canvas.height, { mode, threshold });

  for (let i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
    const isWhite = bin[j] === 255;
    const color = isWhite ? PAPER_RGB : INK_RGB;
    imageData.data[i] = color[0];
    imageData.data[i + 1] = color[1];
    imageData.data[i + 2] = color[2];
    imageData.data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}
