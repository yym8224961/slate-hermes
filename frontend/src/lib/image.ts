// 1bpp 图像解码工具函数。

import { FRAME_WIDTH, FRAME_HEIGHT } from 'shared';
import { PAPER_RGB, INK_RGB } from './colors';

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
  bytes: Uint8Array,
  width: number = FRAME_WIDTH,
  height: number = FRAME_HEIGHT,
  paperColor: readonly [number, number, number] = PAPER_RGB,
  inkColor: readonly [number, number, number] = INK_RGB
): ImageData {
  const data = new ImageData(width, height);
  const bpr = width >> 3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = y * bpr + (x >> 3);
      const bit = (bytes[byteIdx]! >> (7 - (x & 7))) & 1;
      const i = (y * width + x) * 4;
      const c = bit ? paperColor : inkColor;
      data.data[i] = c[0];
      data.data[i + 1] = c[1];
      data.data[i + 2] = c[2];
      data.data[i + 3] = 255;
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
