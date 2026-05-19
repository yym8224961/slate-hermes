import { resolve } from 'node:path';

const BACKEND_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export const ASSETS_DIR = resolve(BACKEND_ROOT, 'assets');
export const VECTOR_FONT_DIR = resolve(ASSETS_DIR, 'fonts', 'vector');
export const BITMAP_1BPP_FONT_DIR = resolve(ASSETS_DIR, 'fonts', 'bitmap-1bpp');
export const QWEATHER_ICON_SVG_DIR = resolve(ASSETS_DIR, 'icons', 'qweather', 'svg');
