import { FONT_TEST_FONTS, type FontTestFontCatalogEntry, type FontTestFontIdT } from 'shared';

export type DeviceFontCatalogEntry = FontTestFontCatalogEntry;

export const DEVICE_FONT_CATALOG: readonly DeviceFontCatalogEntry[] = FONT_TEST_FONTS;

export const DEVICE_FONT_IDS = new Set<FontTestFontIdT>(
  DEVICE_FONT_CATALOG.map((entry) => entry.id)
);

export function getDeviceFontEntry(id: FontTestFontIdT): DeviceFontCatalogEntry {
  return DEVICE_FONT_CATALOG.find((entry) => entry.id === id) ?? DEVICE_FONT_CATALOG[0]!;
}
