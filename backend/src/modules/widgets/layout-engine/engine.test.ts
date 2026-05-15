import { describe, expect, test } from 'bun:test';
import { renderLayout } from './engine';
import type { LayoutCtx, WidgetLayout } from './types';

const ctx: LayoutCtx = {
  config: { locationLabel: '北京' },
  data: {
    tempC: 23,
    humidity: 45,
    windKmh: 12,
    summary: '多云转晴',
    title: 'Hello',
  },
  meta: {},
};

describe('renderLayout', () => {
  test('空 body → 仅白底矩形', () => {
    const layout: WidgetLayout = { size: [400, 300], body: [] };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('height="300"');
    expect(svg).toContain('fill="#fff"');
  });

  test('centered_text 居中输出', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [{ block: 'centered_text', field: 'data.title', size: 24 }],
    };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('Hello');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('font-size="24"');
  });

  test('big_number 带后缀', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [{ block: 'big_number', field: 'data.tempC', suffix: '°C', size: 96 }],
    };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('23°C');
    expect(svg).toContain('font-size="96"');
  });

  test('key_value 两列对齐', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [
        {
          block: 'key_value',
          items: [
            { label: '湿度', field: 'data.humidity', suffix: '%' },
            { label: '风速', field: 'data.windKmh', suffix: ' km/h' },
          ],
        },
      ],
    };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('湿度');
    expect(svg).toContain('45%');
    expect(svg).toContain('12 km/h');
    expect(svg).toContain('text-anchor="end"'); // value 右对齐
  });

  test('separator 输出 line', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [{ block: 'separator', style: 'dashed' }],
    };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('<line');
    expect(svg).toContain('stroke-dasharray');
  });

  test('text wrap=true 在容器宽度处换行', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      padding: 16,
      body: [
        {
          block: 'text',
          field: 'data.summary',
          size: 14,
          wrap: true,
        },
      ],
    };
    const svg = renderLayout(layout, ctx);
    expect(svg).toContain('多云转晴');
  });

  test('field 不存在 → 空字符串 → block 高度 0', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [{ block: 'centered_text', field: 'data.does_not_exist', size: 24 }],
    };
    const svg = renderLayout(layout, ctx);
    // 不应渲染该 block 的 text
    expect(svg).not.toContain('<text');
  });

  test('恶意输入 XML 字符被转义', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [{ block: 'centered_text', field: 'evil', size: 24 }],
    };
    const ctx2: LayoutCtx = {
      config: {},
      data: {},
      meta: {},
      // @ts-expect-error 测试用故意覆盖
      evil: '<script>alert(1)</script>',
    };
    const svg = renderLayout(layout, ctx2);
    expect(svg).not.toContain('<script>');
  });

  test('vertical_stack 嵌套累加高度', () => {
    const layout: WidgetLayout = {
      size: [400, 300],
      body: [
        { block: 'centered_text', field: 'data.title', size: 24 },
        { block: 'separator' },
        { block: 'big_number', field: 'data.tempC', suffix: '°', size: 64 },
      ],
    };
    const svg = renderLayout(layout, ctx);
    // 第二个/第三个 block 应当被 translate 到 y > 0（流式累加）
    expect(svg).toMatch(/translate\(0,[1-9]\d*\)/);
  });
});
