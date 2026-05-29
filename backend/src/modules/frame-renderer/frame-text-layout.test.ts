import { describe, expect, it } from 'bun:test';
import type { BitmapFont } from './bitmap-font';
import { wrapText } from './frame-text-layout';

const font: BitmapFont = {
  name: 'test',
  lineHeight: 8,
  baseLine: 0,
  glyphs: new Map(
    [...'abcdefghijklmnopqrstuvwxyz .'].map((ch) => [
      ch.codePointAt(0)!,
      { bitmap_index: 0, adv_w: 16, box_w: 1, box_h: 1, ofs_x: 0, ofs_y: 0 },
    ])
  ),
  bitmap: new Uint8Array(),
};

describe('wrapText', () => {
  it('ignores blank lines created by consecutive newlines', () => {
    expect(wrapText(font, undefined, 'alpha\n\nbeta', 100, 5, false)).toEqual(['alpha', 'beta']);
  });

  it('does not add ellipsis only because whitespace was normalized', () => {
    expect(wrapText(font, undefined, 'alpha   beta', 100, 1, true)).toEqual(['alpha beta']);
  });

  it('adds ellipsis when max lines actually clip content', () => {
    expect(wrapText(font, undefined, 'alpha beta gamma', 6, 1, true)).toEqual(['alpha.']);
  });
});
