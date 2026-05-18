const TRADITIONAL_FESTIVALS: Array<[string, string]> = [
  ['除夕', '除夕'],
  ['春节', '春节'],
  ['元宵', '元宵'],
  ['上元', '元宵'],
  ['龙抬头', '龙抬头'],
  ['春龙节', '龙抬头'],
  ['上巳', '上巳'],
  ['寒食', '寒食'],
  ['清明', '清明'],
  ['端午', '端午'],
  ['七夕', '七夕'],
  ['中元', '中元'],
  ['中秋', '中秋'],
  ['重阳', '重阳'],
  ['寒衣', '寒衣'],
  ['下元', '下元'],
  ['腊八', '腊八'],
  ['小年', '小年'],
  ['冬至', '冬至'],
];

export function traditionalFestivalShortName(value: string): string {
  const cleaned = value.replace(/^\d+/, '').trim();
  if (!cleaned) return '';
  return TRADITIONAL_FESTIVALS.find(([key]) => cleaned.includes(key))?.[1] ?? '';
}

export function pickTraditionalFestival(values: string[]): string | null {
  for (const value of values) {
    const festival = traditionalFestivalShortName(value);
    if (festival) return festival;
  }
  return null;
}
