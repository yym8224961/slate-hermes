import { afterEach, describe, expect, it } from 'bun:test';
import { ithomeSource } from './ithome';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ithomeSource', () => {
  it('parses full rank cards and removes duplicates across rank sections', async () => {
    globalThis.fetch = (async () => {
      return new Response(`
        <div class="placeholder one-img-plc" data-news-id="956780">
          <a href="https://m.ithome.com/html/956780.htm">
            <div class="plc-image"><span class="rank-num">1</span></div>
            <div class="plc-con">
              <p class="plc-title">比亚迪自研 4nm 智驾芯片发布</p>
              <p class="plc-footer"><span class="review-num">325评</span></p>
            </div>
          </a>
        </div>
        <div class="placeholder one-img-plc" data-news-id="956756">
          <a href="https://m.ithome.com/html/956756.htm">
            <div class="plc-image"><span class="rank-num">2</span></div>
            <div class="plc-con">
              <p class="plc-title">豆包官方回应婴儿喂奶建议</p>
              <p class="plc-footer"><span class="review-num">219评</span></p>
            </div>
          </a>
        </div>
        <div class="placeholder one-img-plc" data-news-id="956780">
          <a href="https://m.ithome.com/html/956780.htm">
            <div class="plc-image"><span class="rank-num">1</span></div>
            <div class="plc-con">
              <p class="plc-title">比亚迪自研 4nm 智驾芯片发布</p>
              <p class="plc-footer"><span class="review-num">999评</span></p>
            </div>
          </a>
        </div>
      `);
    }) as unknown as typeof fetch;

    const data = await ithomeSource.fetch({ signal: new AbortController().signal });

    expect(data).toEqual([
      {
        rank: 1,
        title: '比亚迪自研 4nm 智驾芯片发布',
        hot: '325评',
        url: 'https://www.ithome.com/0/956/780.htm',
      },
      {
        rank: 2,
        title: '豆包官方回应婴儿喂奶建议',
        hot: '219评',
        url: 'https://www.ithome.com/0/956/756.htm',
      },
    ]);
  });
});
