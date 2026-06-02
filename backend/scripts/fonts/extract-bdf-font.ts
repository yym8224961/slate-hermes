#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ExtractedFont, GlyphDsc } from './extracted-font';

interface BdfGlyph {
  encoding: number;
  dwidth: number;
  boxW: number;
  boxH: number;
  ofsX: number;
  ofsY: number;
  rows: string[];
}

function requiredMatch(src: string, re: RegExp, message: string): RegExpMatchArray {
  const match = src.match(re);
  if (!match) throw new Error(message);
  return match;
}

function fontName(src: string, fallback: string): string {
  return src.match(/^FONT\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function numberProperty(src: string, key: string, fallback: number): number {
  const value = src.match(new RegExp(`^${key}\\s+(-?\\d+)`, 'm'))?.[1];
  return value ? Number.parseInt(value, 10) : fallback;
}

function parseGlyph(block: string): BdfGlyph | null {
  const encoding = Number.parseInt(
    requiredMatch(block, /^ENCODING\s+(-?\d+)$/m, 'ENCODING missing')[1]!,
    10
  );
  if (encoding < 0) return null;

  const dwidth = Number.parseInt(
    requiredMatch(block, /^DWIDTH\s+(-?\d+)\s+-?\d+$/m, 'DWIDTH missing')[1]!,
    10
  );
  const box = requiredMatch(block, /^BBX\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/m, 'BBX missing');
  const bitmap = requiredMatch(block, /^BITMAP\n([\s\S]*?)\nENDCHAR$/m, 'BITMAP missing')[1]!
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    encoding,
    dwidth,
    boxW: Number.parseInt(box[1]!, 10),
    boxH: Number.parseInt(box[2]!, 10),
    ofsX: Number.parseInt(box[3]!, 10),
    ofsY: Number.parseInt(box[4]!, 10),
    rows: bitmap,
  };
}

function appendBit(out: number[], bitIndex: number, on: boolean): void {
  if (on) out[bitIndex >> 3] = (out[bitIndex >> 3] ?? 0) | (0x80 >> (bitIndex & 7));
}

function appendGlyphBitmap(out: number[], bitIndex: number, glyph: BdfGlyph): number {
  let bit = bitIndex;
  for (const row of glyph.rows.slice(0, glyph.boxH)) {
    const rowValue = Number.parseInt(row, 16);
    const rowBits = row.length * 4;
    for (let x = 0; x < glyph.boxW; x++) {
      appendBit(out, bit, ((rowValue >> (rowBits - 1 - x)) & 1) === 1);
      bit++;
    }
  }
  return bit;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    throw new Error('usage: bun backend/scripts/fonts/extract-bdf-font.ts <font.bdf> <out.json>');
  }

  const src = await readFile(resolve(input), 'utf8');
  const fallbackHeight = Number.parseInt(
    requiredMatch(
      src,
      /^FONTBOUNDINGBOX\s+-?\d+\s+(-?\d+)\s+-?\d+\s+-?\d+$/m,
      'FONTBOUNDINGBOX missing'
    )[1]!,
    10
  );
  const ascent = numberProperty(src, 'FONT_ASCENT', fallbackHeight);
  const descent = numberProperty(src, 'FONT_DESCENT', 0);
  const glyphs: Record<string, GlyphDsc> = {};
  const bitmap: number[] = [];
  let bitIndex = 0;

  for (const match of src.matchAll(/^STARTCHAR[\s\S]*?^ENDCHAR$/gm)) {
    const glyph = parseGlyph(match[0]);
    if (!glyph) continue;
    if (bitIndex % 8 !== 0) bitIndex += 8 - (bitIndex % 8);
    const bitmapIndex = bitIndex >> 3;
    bitIndex = appendGlyphBitmap(bitmap, bitIndex, glyph);
    glyphs[String(glyph.encoding)] = {
      bitmap_index: bitmapIndex,
      adv_w: glyph.dwidth * 16,
      box_w: glyph.boxW,
      box_h: glyph.boxH,
      ofs_x: glyph.ofsX,
      ofs_y: glyph.ofsY,
    };
  }

  const out: ExtractedFont = {
    name: fontName(src, 'bdf_font'),
    lineHeight: ascent + descent,
    baseLine: descent,
    glyphs,
    bitmapBase64: Buffer.from(bitmap).toString('base64'),
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(out)}\n`);
  process.stdout.write(`extracted ${Object.keys(glyphs).length} glyphs -> ${output}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
