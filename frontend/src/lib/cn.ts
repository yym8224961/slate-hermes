// className 合并工具 — 使用 tailwind-merge 处理 Tailwind class 冲突。
import { twMerge } from 'tailwind-merge';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
