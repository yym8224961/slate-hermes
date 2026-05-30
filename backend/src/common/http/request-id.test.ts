import { describe, expect, it } from 'bun:test';
import { safeRequestId } from './request-id';

describe('safeRequestId', () => {
  it('accepts modern UUID versions used by request id generators', () => {
    expect(safeRequestId('018f6ea2-7b34-7cc8-9a1b-2f1d7b9a0001')).toBe(
      '018f6ea2-7b34-7cc8-9a1b-2f1d7b9a0001'
    );
    expect(safeRequestId('018f6ea2-7b34-8cc8-9a1b-2f1d7b9a0001')).toBe(
      '018f6ea2-7b34-8cc8-9a1b-2f1d7b9a0001'
    );
  });

  it('rejects malformed values', () => {
    expect(safeRequestId('not-a-uuid')).toBeNull();
    expect(safeRequestId('018f6ea2-7b34-9cc8-9a1b-2f1d7b9a0001')).toBeNull();
  });
});
