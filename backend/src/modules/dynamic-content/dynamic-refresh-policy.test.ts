import { describe, expect, it } from 'bun:test';
import { computeErrorBackoffAt } from './dynamic-refresh-policy';

describe('computeErrorBackoffAt', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const delaySec = (attempts: number) =>
    (computeErrorBackoffAt(attempts, now).getTime() - now.getTime()) / 1000;

  it('returns a strictly future time for the first failure', () => {
    expect(computeErrorBackoffAt(1, now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('doubles the delay per consecutive failure', () => {
    expect(delaySec(1)).toBe(60);
    expect(delaySec(2)).toBe(120);
    expect(delaySec(3)).toBe(240);
  });

  it('caps the delay at one hour', () => {
    expect(delaySec(10)).toBe(3600);
    expect(delaySec(100)).toBe(3600);
  });

  it('treats non-positive / fractional attempts as the first failure', () => {
    expect(delaySec(0)).toBe(60);
    expect(delaySec(-5)).toBe(60);
    expect(delaySec(1.9)).toBe(60);
  });

  it('treats non-finite attempts as the first failure (no Invalid Date)', () => {
    expect(delaySec(NaN)).toBe(60);
    expect(delaySec(undefined as unknown as number)).toBe(60);
    expect(Number.isNaN(computeErrorBackoffAt(NaN, now).getTime())).toBe(false);
  });
});
