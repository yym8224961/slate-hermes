# 本地 fork 自 78/xiaozhi-fonts ~1.6.0,只保留状态栏需要的:
#   - font_awesome.{h,c}/font_awesome_14_1.c/font_awesome_30_1.c:WiFi/电池等图标
# 中文字体统一用 main/fonts/SourceHanSansSC_Regular_slim.c。
# 不包含 emoji_32/64.c —— 那俩用了 LVGL 8 的 lv_imgfont_create,LVGL 9 改名 lv_binfont_create
# 编译失败,且我们不需要 emoji 支持。

idf_component_register(
    SRCS
        "src/font_awesome.c"
        "src/font_awesome_14_1.c"
        "src/font_awesome_30_1.c"
    INCLUDE_DIRS
        "include"
    PRIV_REQUIRES
        "lvgl"
)

target_compile_definitions(${COMPONENT_LIB} PUBLIC LV_LVGL_H_INCLUDE_SIMPLE)
