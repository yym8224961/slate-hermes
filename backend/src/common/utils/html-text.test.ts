import { describe, expect, it } from 'bun:test';
import { stripHtml } from './html-text';

describe('stripHtml', () => {
  it('removes tags, decodes html entities, and compacts whitespace', () => {
    expect(stripHtml(' <b>红色</b>&amp;蓝色&nbsp;&#39;预警&#x27; ')).toBe("红色&蓝色 '预警'");
  });
});
