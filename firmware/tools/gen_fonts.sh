#!/usr/bin/env bash
# 生成 main/fonts/ 下的 LVGL 字体 .c 文件。
#
# 用途:
#   - 想换字符集(比如扩到 GB2312 全集) → 改下方 SYMS_FILE / RANGES,重跑。
#   - 想再加一种字体 → 在 download_ttf 阶段加 url, 在 generate 阶段加配置。
#
# 依赖:
#   - node + npm + lv_font_conv:   npm i -g lv_font_conv
#   - curl + unzip
#
# 当前字体:
#   1. 思源黑体 SC Regular slim 16px (生产用,GB2312 6763 字, ~2.16MB) ← 不在脚本里(已有)
#   2. FusionPixel 12px (生产用 ASCII 子集 + FontDemoPage 用 89 字, ~52KB)
#
# 测试集字符见下方 SYMS;扩展 FusionPixel 到全 GB2312 时把 SYMS 换成 GB2312 列表
# 或加 `-r 0x4E00-0x9FA5` 到 RANGES。
#
# 执行:
#   cd firmware && bash tools/gen_fonts.sh
#
set -euo pipefail

WORKDIR="${WORKDIR:-/tmp/font_gen_$$}"
OUTDIR="$(cd "$(dirname "$0")/.." && pwd)/main/fonts"
mkdir -p "$WORKDIR" "$OUTDIR"

# A/B 测试用字符集 — 89 个常用中文,覆盖典型 UI 文本
SYMS='正在准备工程车合集同步进度下载完成失败设备信息数据音量调节恢复出厂立即全屏刷新长按确认短返回已未连接信号弱强中拒绝电充满无池供接入源存储内系统服务器固件时间分秒今日在线离选择操作试听检测'

# 公共范围: ASCII + 中日韩标点
RANGES=(-r 0x20-0x7F -r 0x3000-0x303F)

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
        --symbols "$SYMS" \
        --format lvgl \
        -o "$OUTDIR/${name}.c" \
        --lv-font-name "$name"
}

generate fusion-pixel-12px-proportional-zh_hans.ttf 12 FusionPixel_12

echo
echo "✓ 生成完成 → $OUTDIR"
ls -la "$OUTDIR"/FusionPixel_12.c
