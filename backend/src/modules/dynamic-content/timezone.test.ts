import { describe, expect, it } from 'bun:test';
import { nextLocalMidnight, utcOffsetMin } from './timezone';

describe('timezone helpers', () => {
  it('returns a positive offset for Asia/Shanghai and computes next local midnight', () => {
    const now = new Date('2026-05-27T12:34:00.000Z');

    expect(utcOffsetMin(now, 'Asia/Shanghai')).toBe(480);
    expect(nextLocalMidnight(now, 'Asia/Shanghai').toISOString()).toBe('2026-05-27T16:00:00.000Z');
  });
});
