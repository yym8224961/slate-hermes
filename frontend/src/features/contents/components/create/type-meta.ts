import type { AllContentType } from './content-create-types';

interface TypeMeta {
  /** chip 选择器下方的副标题。 */
  description: string;
  /** 是否有真正的可配参数（决定「类型参数」section 是否渲染）。 */
  hasConfigurableParams: boolean;
  /** 是否支持音频（决定「音频」section 是否渲染）。 */
  supportsAudio: boolean;
  /** 显示名称。 */
  label: string;
}

export const TYPE_META: Record<AllContentType, TypeMeta> = {
  image: {
    label: '图片',
    description: '上传图片并配置抖动 / 阈值；可附音频或 TTS。',
    hasConfigurableParams: true,
    supportsAudio: true,
  },
  daily_calendar: {
    label: '日历',
    description: '显示今日公历、农历与干支。',
    hasConfigurableParams: false,
    supportsAudio: true,
  },
  month_calendar: {
    label: '月历',
    description: '显示当月日历。',
    hasConfigurableParams: false,
    supportsAudio: true,
  },
  weather: {
    label: '天气',
    description: '按城市显示实时天气。数据来自 QWeather。',
    hasConfigurableParams: true,
    supportsAudio: true,
  },
  history_today: {
    label: '历史上的今天',
    description: '自动显示今日历史事件，数据来自维基百科中文版。',
    hasConfigurableParams: false,
    supportsAudio: true,
  },
  dashboard: {
    label: '数据看板',
    description: '由你的系统推送 JSON，设备拉取后渲染指标卡片。',
    hasConfigurableParams: true,
    supportsAudio: false,
  },
  font_test: {
    label: '字体测试',
    description: '测试 Fusion Pixel 字体在墨水屏上的渲染。',
    hasConfigurableParams: true,
    supportsAudio: false,
  },
  hot_list: {
    label: '热榜',
    description: '选择站点热榜，自动刷新并以墨水屏列表展示。',
    hasConfigurableParams: true,
    supportsAudio: false,
  },
};

/**
 * 是否应渲染「类型参数」section。dashboard 在没有 contentId 时无可配项（URL 创建后才生成）。
 */
export function shouldRenderParams(
  t: AllContentType,
  opts?: { contentId?: string | null }
): boolean {
  if (!TYPE_META[t].hasConfigurableParams) return false;
  if (t === 'dashboard') return !!opts?.contentId;
  return true;
}
