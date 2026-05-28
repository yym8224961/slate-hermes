import { describe, expect, it } from 'bun:test';
import { etagMatches } from './etag.util';

describe('etagMatches', () => {
  it('matches quoted, weak, bare, and wildcard ETags', () => {
    expect(etagMatches('"abc"', 'abc')).toBe(true);
    expect(etagMatches('W/"abc"', 'abc')).toBe(true);
    expect(etagMatches('abc', 'abc')).toBe(true);
    expect(etagMatches('*', 'abc')).toBe(true);
  });

  it('ignores malformed tags instead of stripping them into matches', () => {
    expect(etagMatches('W/abc', 'abc')).toBe(false);
    expect(etagMatches('"abc', 'abc')).toBe(false);
    expect(etagMatches('abc"', 'abc')).toBe(false);
  });
});
