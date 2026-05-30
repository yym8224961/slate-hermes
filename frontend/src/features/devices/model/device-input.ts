// MAC 规范化：展示用大写 + 冒号分隔。
export function normalizeMac(input: string): string {
  return (
    input
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '')
      .match(/.{1,2}/g)
      ?.join(':') ?? ''
  );
}

export function isValidMac(input: string): boolean {
  const compact = input.trim().replace(/\s/g, '');
  if (/^[0-9A-Fa-f]{12}$/.test(compact)) return true;
  return /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(compact);
}

// 配对码规范化：去空格、横线，统一大写。
export function normalizePairCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const PAIR_CODE_REGEX = /^[A-Z0-9]{6}$/;

export function isValidPairCode(input: string): boolean {
  return PAIR_CODE_REGEX.test(normalizePairCode(input));
}
