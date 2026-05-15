#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface GlyphDsc {
  bitmap_index: number;
  adv_w: number;
  box_w: number;
  box_h: number;
  ofs_x: number;
  ofs_y: number;
}

interface ExtractedFont {
  name: string;
  lineHeight: number;
  baseLine: number;
  glyphs: Record<string, GlyphDsc>;
  bitmapBase64: string;
}

function parseNumber(v: string): number {
  if (v.startsWith('0x') || v.startsWith('0X')) return Number.parseInt(v.slice(2), 16);
  return Number.parseInt(v, 10);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function parseNumberList(body: string): number[] {
  const nums = stripComments(body).match(/0x[0-9a-fA-F]+|-?\d+/g) ?? [];
  return nums.map(parseNumber);
}

function parseBitmap(src: string): number[] {
  const m = src.match(
    /static\s+LV_ATTRIBUTE_LARGE_CONST\s+const\s+uint8_t\s+glyph_bitmap\[\]\s*=\s*\{([\s\S]*?)\};/
  );
  if (!m) throw new Error('glyph_bitmap not found');
  return parseNumberList(m[1]!);
}

function parseGlyphDsc(src: string): GlyphDsc[] {
  const m = src.match(
    /static\s+const\s+lv_font_fmt_txt_glyph_dsc_t\s+glyph_dsc\[\]\s*=\s*\{([\s\S]*?)\};/
  );
  if (!m) throw new Error('glyph_dsc not found');
  const entries = m[1]!.match(/\{[^}]*\}/g) ?? [];
  return entries.map((entry) => {
    const get = (key: string) => {
      const km = entry.match(new RegExp(`\\.${key}\\s*=\\s*(-?\\d+)`));
      if (!km) throw new Error(`glyph_dsc missing ${key}: ${entry}`);
      return Number.parseInt(km[1]!, 10);
    };
    return {
      bitmap_index: get('bitmap_index'),
      adv_w: get('adv_w'),
      box_w: get('box_w'),
      box_h: get('box_h'),
      ofs_x: get('ofs_x'),
      ofs_y: get('ofs_y'),
    };
  });
}

function parseLineHeight(src: string): number {
  const m = src.match(/\.line_height\s*=\s*(\d+)/);
  if (!m) throw new Error('line_height not found');
  return Number.parseInt(m[1]!, 10);
}

function parseBaseLine(src: string): number {
  const m = src.match(/\.base_line\s*=\s*(\d+)/);
  if (!m) throw new Error('base_line not found');
  return Number.parseInt(m[1]!, 10);
}

function parseFontName(src: string, fallback: string): string {
  const m = src.match(/(?:const\s+)?lv_font_t\s+([A-Za-z0-9_]+)\s*=/);
  return m?.[1] ?? fallback;
}

function parseNamedNumberLists(src: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const re = /static\s+const\s+uint(?:8|16|32)_t\s+([A-Za-z0-9_]+)\[\]\s*=\s*\{([\s\S]*?)\};/g;
  for (const m of src.matchAll(re)) {
    out.set(m[1]!, parseNumberList(m[2]!));
  }
  return out;
}

function parseCmapEntries(src: string): string[] {
  const cmapsBlock = src.match(
    /static\s+const\s+lv_font_fmt_txt_cmap_t\s+cmaps\[\]\s*=\s*\{([\s\S]*?)\};/
  );
  if (!cmapsBlock) throw new Error('cmaps not found');
  return cmapsBlock[1]!.match(/\{[\s\S]*?\}/g) ?? [];
}

function parseField(entry: string, key: string): string | null {
  const m = entry.match(new RegExp(`\\.${key}\\s*=\\s*([^,}]+)`));
  return m?.[1]?.trim() ?? null;
}

function parseRequiredNumber(entry: string, key: string): number {
  const raw = parseField(entry, key);
  if (!raw) throw new Error(`cmap missing ${key}: ${entry}`);
  return parseNumber(raw);
}

function parsePtrName(entry: string, key: string): string | null {
  const raw = parseField(entry, key);
  if (!raw || raw === 'NULL') return null;
  return raw.replace(/^\(?\s*/, '').replace(/\s*\)?$/, '');
}

function parseLvglCharmap(src: string): Record<string, number> {
  const entries = parseCmapEntries(src);
  const lists = parseNamedNumberLists(src);
  const map: Record<string, number> = {};

  for (const entry of entries) {
    const type = parseField(entry, 'type') ?? '';
    const rangeStart = parseRequiredNumber(entry, 'range_start');
    const rangeLength = parseRequiredNumber(entry, 'range_length');
    const glyphIdStart = parseRequiredNumber(entry, 'glyph_id_start');
    const listLength = parseRequiredNumber(entry, 'list_length');

    if (type.includes('FORMAT0_TINY')) {
      for (let i = 0; i < rangeLength; i++) {
        map[String(rangeStart + i)] = glyphIdStart + i;
      }
      continue;
    }

    if (type.includes('SPARSE_TINY')) {
      const unicodeListName = parsePtrName(entry, 'unicode_list');
      if (!unicodeListName) throw new Error(`SPARSE_TINY cmap missing unicode_list: ${entry}`);
      const unicodeList = lists.get(unicodeListName);
      if (!unicodeList) throw new Error(`${unicodeListName} not found`);
      for (let i = 0; i < Math.min(listLength, unicodeList.length); i++) {
        map[String(rangeStart + unicodeList[i]!)] = glyphIdStart + i;
      }
      continue;
    }

    if (type.includes('FORMAT0_FULL')) {
      const glyphOfsName = parsePtrName(entry, 'glyph_id_ofs_list');
      if (!glyphOfsName) throw new Error(`FORMAT0_FULL cmap missing glyph_id_ofs_list: ${entry}`);
      const glyphOfs = lists.get(glyphOfsName);
      if (!glyphOfs) throw new Error(`${glyphOfsName} not found`);
      for (let i = 0; i < Math.min(listLength, glyphOfs.length, rangeLength); i++) {
        const ofs = glyphOfs[i]!;
        if (ofs === 0 && i !== 0) continue;
        map[String(rangeStart + i)] = glyphIdStart + ofs;
      }
      continue;
    }

    throw new Error(`unsupported cmap type: ${type}`);
  }
  return map;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    throw new Error('usage: bun backend/scripts/extract-lvgl-font.ts <font.c> <out.json>');
  }
  const src = await readFile(resolve(input), 'utf8');
  const bitmap = parseBitmap(src);
  const glyphDsc = parseGlyphDsc(src);
  const charmap = parseLvglCharmap(src);
  const glyphs: Record<string, GlyphDsc> = {};
  for (const [codepoint, glyphId] of Object.entries(charmap)) {
    const dsc = glyphDsc[glyphId];
    if (dsc) glyphs[codepoint] = dsc;
  }
  const out: ExtractedFont = {
    name: parseFontName(src, 'lvgl_font'),
    lineHeight: parseLineHeight(src),
    baseLine: parseBaseLine(src),
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
