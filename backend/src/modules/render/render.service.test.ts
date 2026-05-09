import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_BYTES, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { RenderService } from './render.service';
import { RenderCacheService } from './render-cache.service';

let tmp = '';
let cache: RenderCacheService;
let renderer: RenderService;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'render-test-'));
  cache = new RenderCacheService({ blobDir: tmp } as never);
  renderer = new RenderService(cache);
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function makePng(
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: fill },
  })
    .png()
    .toBuffer();
}

describe('RenderService', () => {
  it('白图渲染后全白(全 0xff)', async () => {
    const input = await makePng(800, 600, { r: 255, g: 255, b: 255 });
    const { data, width, height } = await renderer.renderTo1bpp(input);
    expect(width).toBe(FRAME_WIDTH);
    expect(height).toBe(FRAME_HEIGHT);
    expect(data.length).toBe(FRAME_BYTES);
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('黑图(autoInvert 触发) 仍是白', async () => {
    const input = await makePng(800, 600, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input);
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('autoInvert=false 时全黑图保持全黑(全 0x00)', async () => {
    const input = await makePng(800, 600, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input, { autoInvert: false });
    expect(data.every((b) => b === 0x00)).toBe(true);
  });

  it('size 验证', async () => {
    const input = await makePng(100, 100, { r: 128, g: 128, b: 128 });
    const { data } = await renderer.renderTo1bpp(input);
    expect(() => renderer.validateFrameSize(data)).not.toThrow();
    expect(() => renderer.validateFrameSize(Buffer.alloc(100))).toThrow();
  });

  it('width 不是 8 的倍数时报错', async () => {
    const input = await makePng(100, 100, { r: 0, g: 0, b: 0 });
    await expect(renderer.renderTo1bpp(input, { width: 401, height: 300 })).rejects.toThrow(
      /multiple of 8/
    );
  });

  it('mode 默认为 threshold(向后兼容)', async () => {
    const input = await makePng(400, 300, { r: 255, g: 255, b: 255 });
    const { data: defaultData } = await renderer.renderTo1bpp(input);
    const { data: explicitData } = await renderer.renderTo1bpp(input, {
      mode: 'threshold',
    });
    expect(Buffer.compare(defaultData, explicitData)).toBe(0);
  });

  it('atkinson 全黑图(autoInvert off) 输出全黑', async () => {
    const input = await makePng(400, 300, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input, {
      mode: 'atkinson',
      autoInvert: false,
    });
    expect(data.every((b) => b === 0x00)).toBe(true);
  });

  it('bayer8 全白图输出全白', async () => {
    const input = await makePng(400, 300, { r: 255, g: 255, b: 255 });
    const { data } = await renderer.renderTo1bpp(input, { mode: 'bayer8' });
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('同图二次渲染应命中缓存（fromCache=true）', async () => {
    const input = await makePng(400, 300, { r: 32, g: 64, b: 128 });
    const r1 = await renderer.renderTo1bpp(input, { mode: 'floyd' });
    expect(r1.fromCache).toBe(false);
    const r2 = await renderer.renderTo1bpp(input, { mode: 'floyd' });
    expect(r2.fromCache).toBe(true);
    expect(Buffer.compare(r1.data, r2.data)).toBe(0);
  });

  it('opts 不同 → key 不同 → fromCache=false', async () => {
    const input = await makePng(400, 300, { r: 100, g: 100, b: 100 });
    const r1 = await renderer.renderTo1bpp(input, { mode: 'threshold', threshold: 100 });
    const r2 = await renderer.renderTo1bpp(input, { mode: 'threshold', threshold: 200 });
    expect(r1.fromCache).toBe(false);
    expect(r2.fromCache).toBe(false);
  });
});
