#!/usr/bin/env bash
# 生成 main/generated/fonts/ 下的 LVGL 字体 .c 文件。
#
# 用途:
#   - 想换字符集(比如扩到 GB2312 全集) → 改下方 RANGES,重跑。
#   - 想再加一种字体 → 在 download_ttf 阶段加 url, 在 generate 阶段加配置。
#
# 依赖:
#   - node + npm + lv_font_conv:   npm i -g lv_font_conv
#   - curl + unzip
#
# 当前字体:
#   1. 思源黑体 SC Regular slim 16px (生产用,GB2312 6763 字, ~2.16MB) ← 不在脚本里(已有)
#   2. FusionPixel 12px (生产用 ASCII 子集,状态栏百分比数字)
#
# 执行:
#   cd firmware && bash tools/gen_fonts.sh
#
set -euo pipefail

WORKDIR="${WORKDIR:-/tmp/font_gen_$$}"
OUTDIR="$(cd "$(dirname "$0")/.." && pwd)/main/generated/fonts"
mkdir -p "$WORKDIR" "$OUTDIR"

# 状态栏百分比只需要 ASCII（数字、%、-）。
RANGES=(-r 0x20-0x7F)

# ---- 1. 下载 ttf ----
fetch() {
    local url="$1" out="$2"
    [ -f "$WORKDIR/$out" ] && return
    echo "↓ $out"
    curl -sLf -o "$WORKDIR/$out" "$url"
}

cd "$WORKDIR"

fetch 'https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.05.07/fusion-pixel-font-12px-proportional-ttf-v2026.05.07.zip'  fusion.zip

[ -f fusion-pixel-12px-proportional-zh_hans.ttf ] || unzip -o -q fusion.zip

# ---- 2. lv_font_conv 转换 ----
generate() {
    local ttf="$1" size="$2" name="$3"
    echo "▸ $name (size=$size)"
    lv_font_conv \
        --no-compress \
        --bpp 1 --size "$size" \
        --font "$ttf" --autohint-off \
        "${RANGES[@]}" \
        --format lvgl \
        -o "${name}.c" \
        --lv-font-name "$name"
    local out
    out="$(echo "$name" | sed -E 's/([a-z0-9])([A-Z])/\1_\2/g; s/([A-Z]+)([A-Z][a-z])/\1_\2/g' | tr '[:upper:]' '[:lower:]')"
    mv "${name}.c" "$OUTDIR/${out}.c"
}

generate fusion-pixel-12px-proportional-zh_hans.ttf 12 FusionPixel_12

echo
echo "✓ 生成完成 → $OUTDIR"
ls -la "$OUTDIR"/fusion_pixel_12.c
