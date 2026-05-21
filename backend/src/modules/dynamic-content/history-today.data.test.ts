import { describe, expect, it } from 'bun:test';
import { normalizeHistoryTodayAiData } from './providers/history-today.provider';
import { parseHistoryTodayData } from './history-today.data';

describe('history today data contract', () => {
  it('normalizes AI year variants with spaces', () => {
    const data = normalizeHistoryTodayAiData(
      {
        dateLabel: '5月21日',
        items: [
          { year: '公元 1904 年', display: '1904 · 国际足联在巴黎成立' },
          { year: '公元前 221 年', display: '秦统一六国，建立统一王朝。' },
          { year: '-044', display: '凯撒遇刺，罗马共和政治陷入动荡' },
          { year: '0221', display: '刘备称帝，蜀汉政权正式建立' },
        ],
      },
      '5月21日'
    );

    expect(data).toEqual({
      dateLabel: '5月21日',
      items: [
        { year: '1904', display: '国际足联在巴黎成立' },
        { year: '前221', display: '秦统一六国，建立统一王朝' },
        { year: '前44', display: '凯撒遇刺，罗马共和政治陷入动荡' },
        { year: '221', display: '刘备称帝，蜀汉政权正式建立' },
      ],
    });
  });

  it('rejects zero years', () => {
    expect(
      parseHistoryTodayData({
        dateLabel: '5月21日',
        items: [{ year: '0', display: '无效年份' }],
      })
    ).toBeNull();
    expect(
      parseHistoryTodayData({
        dateLabel: '5月21日',
        items: [{ year: '前0', display: '无效年份' }],
      })
    ).toBeNull();
  });
});
