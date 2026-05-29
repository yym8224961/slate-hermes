export async function* parseSseJson<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buf.match(/\r?\n\r?\n/))) {
        const idx = boundary.index ?? 0;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + boundary[0].length);
        const data = parseSseBlock<T>(block);
        if (data === null) continue;
        yield data;
      }
    }
    buf += decoder.decode();
    for (const data of parseSseBlocks<T>(buf)) {
      yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

export class SseJsonParseError extends Error {
  constructor(
    readonly payload: string,
    readonly cause: unknown
  ) {
    super(`SSE JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SseJsonParseError';
  }
}

export function* parseSsePayloads(text: string): Generator<string> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));
    if (lines.length === 0) continue;
    const payload = lines.map((line) => line.slice(5).trim()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    yield payload;
  }
}

function* parseSseBlocks<T>(text: string): Generator<T> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = parseSseBlock<T>(block);
    if (data !== null) yield data;
  }
}

function parseSseBlock<T>(block: string): T | null {
  const payload = [...parseSsePayloads(block)].join('\n');
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    throw new SseJsonParseError(payload.slice(0, 512), err);
  }
}
