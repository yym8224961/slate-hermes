// 配对码规范化：去空格、横线，统一大写。
export function normalizePairCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const PAIR_CODE_REGEX = /^[A-Z0-9]{6}$/;

export function isValidPairCode(input: string): boolean {
  return PAIR_CODE_REGEX.test(normalizePairCode(input));
}
