import { describe, expect, it } from 'bun:test';
import { MIN_DYNAMIC_WAKE_SEC, nextWakeSec } from './content-presenter';

describe('nextWakeSec', () => {
  const now = new Date('2026-01-01T00:00:00.000Z').getTime();

  it('returns null for static frames (no nextRunAt)', () => {
    expect(nextWakeSec(null, now)).toBeNull();
  });

  it('returns remaining seconds for a future refresh', () => {
    expect(nextWakeSec(new Date(now + 3600_000), now)).toBe(3600);
  });

  it('floors a due / overdue dynamic frame to the minimum instead of 0', () => {
    expect(nextWakeSec(new Date(now), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
    expect(nextWakeSec(new Date(now - 10_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });

  it('floors a sub-minimum positive interval to the minimum', () => {
    expect(nextWakeSec(new Date(now + 5_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });
});
