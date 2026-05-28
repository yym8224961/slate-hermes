import { resolve } from 'node:path';

const MODULE_DIR = import.meta.dirname ?? import.meta.dir;
const BACKEND_ROOT = resolve(MODULE_DIR, '..', '..', '..');

export const ASSETS_DIR = resolve(BACKEND_ROOT, 'assets');
export const VECTOR_FONT_DIR = resolve(ASSETS_DIR, 'fonts', 'vector');
export const BITMAP_1BPP_FONT_DIR = resolve(ASSETS_DIR, 'fonts', 'bitmap-1bpp');
export const QWEATHER_ICON_SVG_DIR = resolve(ASSETS_DIR, 'icons', 'qweather', 'svg');
