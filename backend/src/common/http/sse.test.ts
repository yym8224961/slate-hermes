import { describe, expect, it } from 'bun:test';
import { parseSseJson, parseSsePayloads, SseJsonParseError } from './sse';

describe('parseSseJson', () => {
  it('parses multiple final events left in the trailing buffer', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n')
        );
        controller.close();
      },
    });

    const items: Array<{ n: number }> = [];
    for await (const item of parseSseJson<{ n: number }>(stream)) {
      items.push(item);
    }

    expect(items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('parses a final event without a trailing blank line', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"n":1}'));
        controller.close();
      },
    });

    const items: Array<{ n: number }> = [];
    for await (const item of parseSseJson<{ n: number }>(stream)) {
      items.push(item);
    }

    expect(items).toEqual([{ n: 1 }]);
  });

  it('flushes a final partial UTF-8 character before parsing the trailing event', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"雪"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, -1));
        controller.enqueue(bytes.slice(-1));
        controller.close();
      },
    });

    const items: Array<{ text: string }> = [];
    for await (const item of parseSseJson<{ text: string }>(stream)) {
      items.push(item);
    }

    expect(items).toEqual([{ text: '雪' }]);
  });

  it('parses payload helper input without a trailing blank line', () => {
    expect([...parseSsePayloads('data: {"ok":true}')]).toEqual(['{"ok":true}']);
  });

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
