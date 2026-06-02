export interface GlyphDsc {
  bitmap_index: number;
  adv_w: number;
  box_w: number;
  box_h: number;
  ofs_x: number;
  ofs_y: number;
}

export interface ExtractedFont {
  name: string;
  lineHeight: number;
  baseLine: number;
  glyphs: Record<string, GlyphDsc>;
  bitmapBase64: string;
}
