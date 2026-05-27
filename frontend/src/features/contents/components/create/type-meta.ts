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
    description: '自动显示今日历史事件，可选维基百科或百度百科。',
    hasConfigurableParams: true,
    supportsAudio: true,
  },
  weather_alert: {
    label: '气象预警',
    description: '显示中央气象台全国或指定省份气象预警。',
    hasConfigurableParams: true,
    supportsAudio: true,
  },
  earthquake_report: {
    label: '地震速报',
    description: '显示中国地震台网最新地震速报。',
    hasConfigurableParams: true,
    supportsAudio: true,
  },
  dashboard: {
    label: '外部数据',
    description: '选择系统模板或自定义模板，后续只推送数据即可刷新画面。',
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
 * 是否应渲染「类型参数」section。
 */
export function shouldRenderParams(t: AllContentType): boolean {
  if (!TYPE_META[t].hasConfigurableParams) return false;
  return true;
}
