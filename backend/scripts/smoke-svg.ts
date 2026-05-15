#!/usr/bin/env bun
/**
 * SVG → PNG smoke test。
 *
 * 用途：CI / docker build 完跑一次，确保 sharp 能在当前镜像里把 SVG 转栅格。
 *      字体缺失会让中文走 "tofu"（豆腐块）但 sharp 本身不会抛错——只有真正抛
 *      才说明 librsvg 链路坏了。
 *
 * 退出码：0 = 通过；1 = 失败。
 */
import sharp from 'sharp';

async function main(): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect x="0" y="0" width="400" height="300" fill="#fff"/>
  <text x="200" y="60" text-anchor="middle" font-family="'Noto Serif SC', serif" font-size="40" fill="#000">墨笺</text>
  <text x="200" y="120" text-anchor="middle" font-family="'IBM Plex Sans', 'Noto Sans CJK SC', sans-serif" font-size="20" fill="#000">Slate Widget Smoke</text>
  <text x="200" y="200" text-anchor="middle" font-family="monospace" font-size="80" font-weight="bold" fill="#000">23°C</text>
</svg>`;

  const png = await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer();
  if (png.byteLength < 100) {
    throw new Error(`PNG 输出过小：${png.byteLength} bytes，可能 sharp 没正常渲染`);
  }
  // 拉成 400x300 灰度 raw —— 真实管线就是这一步
  const gray = await sharp(Buffer.from(svg), { density: 96 })
    .flatten({ background: '#fff' })
    .resize(400, 300, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  if (gray.byteLength !== 400 * 300) {
    throw new Error(`灰度 raw 字节数错误：期望 ${400 * 300} 实得 ${gray.byteLength}`);
  }
  process.stdout.write(`✓ sharp SVG→PNG OK (${png.byteLength} bytes)\n`);
  process.stdout.write(`✓ sharp SVG→raw gray OK (${gray.byteLength} bytes)\n`);
}

main().catch((e) => {
  process.stderr.write(`✗ smoke-svg 失败: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
