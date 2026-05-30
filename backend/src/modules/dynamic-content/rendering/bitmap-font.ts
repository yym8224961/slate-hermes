import { readFile } from 'node:fs/promises';
import { setBoundedCache } from '../../../common/cache-utils';

export interface BitmapGlyph {
  bitmap_index: number;
  adv_w: number;
  box_w: number;
  box_h: number;
  ofs_x: number;
  ofs_y: number;
}

export interface BitmapFont {
  name: string;
  lineHeight: number;
  baseLine: number;
  glyphs: Map<number, BitmapGlyph>;
  bitmap: Uint8Array;
}

interface SerializedBitmapFont {
  name: string;
  lineHeight: number;
  baseLine?: number;
  glyphs: Record<string, BitmapGlyph>;
  bitmapBase64: string;
}

const fontCache = new Map<string, Promise<BitmapFont>>();
const MAX_FONT_CACHE_ENTRIES = 64;

export async function loadBitmapFont(path: string): Promise<BitmapFont> {
  const cached = fontCache.get(path);
  if (cached) {
    fontCache.delete(path);
    fontCache.set(path, cached);
    return cached;
  }
  const task = readBitmapFont(path).catch((err: unknown) => {
    fontCache.delete(path);
    throw err;
  });
  setBoundedCache(fontCache, path, task, MAX_FONT_CACHE_ENTRIES);
  return task;
}

async function readBitmapFont(path: string): Promise<BitmapFont> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as SerializedBitmapFont;
  return {
    name: raw.name,
    lineHeight: raw.lineHeight,
    baseLine: raw.baseLine ?? 0,
    glyphs: new Map(Object.entries(raw.glyphs).map(([k, v]) => [Number(k), v])),
    bitmap: new Uint8Array(Buffer.from(raw.bitmapBase64, 'base64')),
  };
}

export function textWidth(font: BitmapFont, text: string): number {
  let w = 0;
  for (const ch of text) {
    const glyph = font.glyphs.get(ch.codePointAt(0)!);
    if (glyph) w += Math.round(glyph.adv_w / 16);
  }
  return w;
}

export function hasGlyph(font: BitmapFont, codepoint: number): boolean {
  return font.glyphs.has(codepoint);
}
