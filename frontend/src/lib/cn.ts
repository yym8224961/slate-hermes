// 极简 className concat 工具,不需要 clsx/twmerge——本项目 Tailwind class 冲突可手控。
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
