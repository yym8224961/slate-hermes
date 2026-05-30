export function shortRegionName(
  value: string,
  opts: { stripWeatherOffice?: boolean } = {}
): string {
  const text = value.replace(/\s+/g, '');
  if (!text) return '';
  if (text.includes('中央气象台')) return '中央气象台';

  const shortened = text
    .replace(/广西壮族自治区/g, '广西')
    .replace(/宁夏回族自治区/g, '宁夏')
    .replace(/新疆维吾尔自治区/g, '新疆')
    .replace(/内蒙古自治区/g, '内蒙古')
    .replace(/西藏自治区/g, '西藏')
    .replace(/特别行政区/g, '');

  return opts.stripWeatherOffice
    ? shortened.replace(/气象台$/, '').replace(/气象局$/, '')
    : shortened.replace(/省|市|气象台|气象局/g, '').slice(0, 12);
}
