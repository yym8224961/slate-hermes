import { describe, expect, it } from 'bun:test';
import { formatShortTime, parseDateLike } from './frame-date-utils';

describe('frame date utils', () => {
  it('parses no-zone date-time strings in the requested time zone', () => {
    const parsed = parseDateLike('2026-05-21 08:30', 'Asia/Shanghai');

    expect(parsed.toISOString()).toBe('2026-05-21T00:30:00.000Z');
  });

  it('preserves explicit offsets when formatting short time', () => {
    const fallback = new Date('2026-05-21T00:00:00.000Z');

    expect(formatShortTime('2026-05-21T08:30:00+09:00', fallback, 'Asia/Shanghai')).toBe('07:30');
  });
});
