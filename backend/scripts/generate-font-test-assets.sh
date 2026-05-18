#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_DIR="${SLATE_FONT_PROBE_DIR:-/private/tmp/slate-font-probe}"
WORK_DIR="${SLATE_FONT_WORK_DIR:-/private/tmp/slate-font-test}"
OUT_DIR="$ROOT/backend/assets/fonts/bitmap-1bpp"
SYMBOLS="墨水屏字体测试中文点阵简繁日"

mkdir -p "$PROBE_DIR" "$WORK_DIR" "$OUT_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

convert_ttf() {
  local src="$1"
  local size="$2"
  local name="$3"
  local out="$4"
  local extra="${5:-$SYMBOLS}"
  local c_file="$WORK_DIR/$out.c"
  if [[ -n "$extra" ]]; then
    lv_font_conv --no-compress --bpp 1 --size "$size" --font "$src" --autohint-off \
      -r 0x20-0x7F --symbols "$extra" --format lvgl -o "$c_file" --lv-font-name "$name"
  else
    lv_font_conv --no-compress --bpp 1 --size "$size" --font "$src" --autohint-off \
      -r 0x20-0x7F --format lvgl -o "$c_file" --lv-font-name "$name"
  fi
  bun "$ROOT/backend/scripts/extract-lvgl-font.ts" "$c_file" "$OUT_DIR/$out.json"
}

download_release() {
  local repo="$1"
  local tag="$2"
  local dir="$3"
  shift 3
  mkdir -p "$dir"
  gh release download "$tag" --repo "$repo" --dir "$dir" --clobber "$@"
}

need bun
need gh
need lv_font_conv
need unzip
need tar

download_release TakWolf/fusion-pixel-font 2026.05.07 "$PROBE_DIR/fusion8" --pattern "fusion-pixel-font-8px-proportional-ttf-*.zip"
download_release TakWolf/fusion-pixel-font 2026.05.07 "$PROBE_DIR/fusion10" --pattern "fusion-pixel-font-10px-proportional-ttf-*.zip"
download_release TakWolf/fusion-pixel-font 2026.05.07 "$PROBE_DIR/fusion12" --pattern "fusion-pixel-font-12px-proportional-ttf-*.zip"
download_release TakWolf/ark-pixel-font 2026.05.07 "$PROBE_DIR/ark10" --pattern "ark-pixel-font-10px-proportional-ttf-*.zip"
download_release TakWolf/ark-pixel-font 2026.05.07 "$PROBE_DIR/ark12" --pattern "ark-pixel-font-12px-proportional-ttf-*.zip"
download_release TakWolf/ark-pixel-font 2026.05.07 "$PROBE_DIR/ark16" --pattern "ark-pixel-font-16px-proportional-ttf-*.zip"
download_release fcambus/spleen 2.2.0 "$PROBE_DIR/spleen" --pattern "spleen-2.2.0.tar.gz"
download_release the-moonwitch/Cozette v.1.30.0 "$PROBE_DIR/cozette" --pattern "CozetteVector.ttf"
download_release DWNfonts/MuzaiPixel 2.0.20241013 "$PROBE_DIR/muzai" --pattern "MZPXflat.ttf"
download_release multitheftauto/unifont v16.0.04 "$PROBE_DIR/unifont" --pattern "unifont-16.0.04.otf"
download_release itouhiro/PixelMplus v1.0.0 "$PROBE_DIR/pixelmplus" --pattern "PixelMplus-20130602.zip"

curl -L -o "$PROBE_DIR/cubic11/Cubic_11.ttf" https://raw.githubusercontent.com/ACh-K/Cubic-11/main/fonts/ttf/Cubic_11.ttf

unzip -o -q "$PROBE_DIR/fusion8"/fusion-pixel-font-8px-proportional-ttf-*.zip -d "$PROBE_DIR/fusion8"
unzip -o -q "$PROBE_DIR/fusion10"/fusion-pixel-font-10px-proportional-ttf-*.zip -d "$PROBE_DIR/fusion10"
unzip -o -q "$PROBE_DIR/fusion12"/fusion-pixel-font-12px-proportional-ttf-*.zip -d "$PROBE_DIR/fusion12"
unzip -o -q "$PROBE_DIR/ark10"/ark-pixel-font-10px-proportional-ttf-*.zip -d "$PROBE_DIR/ark10"
unzip -o -q "$PROBE_DIR/ark12"/ark-pixel-font-12px-proportional-ttf-*.zip -d "$PROBE_DIR/ark12"
unzip -o -q "$PROBE_DIR/ark16"/ark-pixel-font-16px-proportional-ttf-*.zip -d "$PROBE_DIR/ark16"
unzip -o -q "$PROBE_DIR/pixelmplus/PixelMplus-20130602.zip" -d "$PROBE_DIR/pixelmplus"
tar -xzf "$PROBE_DIR/spleen/spleen-2.2.0.tar.gz" -C "$PROBE_DIR/spleen"

convert_ttf "$PROBE_DIR/fusion8/fusion-pixel-8px-proportional-zh_hans.ttf" 8 FusionPixel_8 fusion-pixel-8
convert_ttf "$PROBE_DIR/fusion10/fusion-pixel-10px-proportional-zh_hans.ttf" 10 FusionPixel_10 fusion-pixel-10
convert_ttf "$PROBE_DIR/fusion12/fusion-pixel-12px-proportional-zh_hans.ttf" 12 FusionPixel_12 fusion-pixel-12
convert_ttf "$PROBE_DIR/ark10/ark-pixel-10px-proportional-zh_cn.ttf" 10 ArkPixel_10 ark-pixel-10
convert_ttf "$PROBE_DIR/ark12/ark-pixel-12px-proportional-zh_cn.ttf" 12 ArkPixel_12 ark-pixel-12
convert_ttf "$PROBE_DIR/ark16/ark-pixel-16px-proportional-zh_cn.ttf" 16 ArkPixel_16 ark-pixel-16
convert_ttf "$PROBE_DIR/cubic11/Cubic_11.ttf" 11 Cubic_11 cubic-11
convert_ttf "$PROBE_DIR/muzai/MZPXflat.ttf" 12 MuzaiPixel_12 muzai-pixel-12
convert_ttf "$PROBE_DIR/unifont/unifont-16.0.04.otf" 16 Unifont_16 unifont-16
convert_ttf "$PROBE_DIR/cozette/CozetteVector.ttf" 13 Cozette_13 cozette-13 ""
convert_ttf "$PROBE_DIR/pixelmplus/PixelMplus-20130602/PixelMplus10-Regular.ttf" 10 PixelMplus_10 pixelmplus-10 ""
convert_ttf "$PROBE_DIR/pixelmplus/PixelMplus-20130602/PixelMplus12-Regular.ttf" 12 PixelMplus_12 pixelmplus-12 ""

for item in 6x12:12 8x16:16 12x24:24 16x32:32 32x64:64; do
  name="${item%%:*}"
  size="${item##*:}"
  convert_ttf "$PROBE_DIR/spleen/spleen-2.2.0/spleen-$name.otf" "$size" "Spleen_${name//x/_}" "spleen-$name" ""
done

bun "$ROOT/backend/scripts/extract-bdf-font.ts" "$PROBE_DIR/spleen/spleen-2.2.0/spleen-5x8.bdf" "$OUT_DIR/spleen-5x8.json"
bun "$ROOT/backend/scripts/extract-lvgl-font.ts" "$ROOT/firmware/components/xiaozhi-fonts/src/font_awesome_14_1.c" "$OUT_DIR/font-awesome-14.json"
bun "$ROOT/backend/scripts/extract-lvgl-font.ts" "$ROOT/firmware/components/xiaozhi-fonts/src/font_awesome_30_1.c" "$OUT_DIR/font-awesome-30.json"
