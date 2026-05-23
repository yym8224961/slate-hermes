const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function stripHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
      const decoded = decodeHtmlEntity(entity);
      return decoded ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntity(entity: string): string | null {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith('#x')) return codePointToString(parseInt(normalized.slice(2), 16));
  if (normalized.startsWith('#')) return codePointToString(parseInt(normalized.slice(1), 10));
  return HTML_ENTITIES[normalized] ?? null;
}

function codePointToString(codePoint: number): string | null {
  if (!Number.isFinite(codePoint) || codePoint <= 0) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}
