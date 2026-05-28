import { describe, expect, it } from 'bun:test';
import { parseSseJson, SseJsonParseError } from './sse';

describe('parseSseJson', () => {
  it('throws on invalid JSON payloads instead of silently dropping them', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":\n\n'));
        controller.close();
      },
    });

    try {
      for await (const item of parseSseJson(stream)) {
        throw new Error(`unexpected SSE item: ${String(item)}`);
      }
      throw new Error('expected parse error');
    } catch (err) {
      expect(err).toBeInstanceOf(SseJsonParseError);
      expect((err as SseJsonParseError).payload).toBe('{"choices":');
    }
  });
});
