// 1bpp 图像解码工具函数。

import { FRAME_WIDTH, FRAME_HEIGHT } from 'shared';
import { PAPER_HEX, PAPER_RGB, INK_RGB } from './colors';

/**
 * 将 1bpp 二进制数据解码为 ImageData。
 *
 * @param bytes - 1bpp 二进制数据（MSB-first，bit=1 白，bit=0 黑）
 * @param width - 图像宽度（必须是 8 的倍数）
 * @param height - 图像高度
 * @param paperColor - 纸本颜色 RGB 数组
 * @param inkColor - 墨色 RGB 数组
 * @returns ImageData 对象
 */
export function decodeBppImage(
  bytes: Uint8Array | ArrayBuffer,
  width: number = FRAME_WIDTH,
  height: number = FRAME_HEIGHT,
  paperColor: readonly [number, number, number] = PAPER_RGB,
  inkColor: readonly [number, number, number] = INK_RGB
): ImageData {
  const byteView = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const data = new ImageData(width, height);
  const bpr = width >> 3;
  const pixels = new Uint32Array(data.data.buffer);
  const paperPixel = rgbaPixel(paperColor);
  const inkPixel = rgbaPixel(inkColor);
  let dst = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * bpr;
    for (let byteOffset = 0; byteOffset < bpr; byteOffset++) {
      const byte = byteView[rowStart + byteOffset]!;
      pixels[dst++] = byte & 0b1000_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0100_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0010_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0001_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_1000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0100 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0010 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0001 ? paperPixel : inkPixel;
    }
  }

  return data;
}

/**
 * 验证 1bpp 数据长度是否正确。
 *
 * @param bytes - 1bpp 二进制数据
 * @param width - 图像宽度
 * @param height - 图像高度
 * @returns 数据长度是否正确
 */
export function isValidBppLength(
  bytes: Uint8Array | ArrayBuffer,
  width: number = FRAME_WIDTH,
  height: number = FRAME_HEIGHT
): boolean {
  const byteLength = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
  return byteLength === (width * height) / 8;
}

export function clearCanvas(
  ctx: CanvasRenderingContext2D,
  canvas?: { width: number; height: number }
): void {
  ctx.fillStyle = PAPER_HEX;
  ctx.fillRect(0, 0, canvas?.width ?? FRAME_WIDTH, canvas?.height ?? FRAME_HEIGHT);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

function rgbaPixel(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  return LITTLE_ENDIAN
    ? 0xff000000 | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | 0xff;
}
