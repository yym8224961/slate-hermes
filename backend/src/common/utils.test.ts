import { describe, expect, it } from 'bun:test';
import { shortRegionName } from './utils';

describe('shortRegionName', () => {
  it('shortens every autonomous-region occurrence', () => {
    expect(shortRegionName('广西壮族自治区宁夏回族自治区广西壮族自治区')).toBe(
      '广西宁夏广西'
    );
  });
});
