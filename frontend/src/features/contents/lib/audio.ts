export function pcm16LeToAudioBuffer(
  ctx: AudioContext,
  data: ArrayBuffer,
  sampleRate: number
): AudioBuffer {
  if (data.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('PCM 数据长度不是 16-bit 对齐。');
  }

  const view = new DataView(data);
  const sampleCount = data.byteLength / Int16Array.BYTES_PER_ELEMENT;
  const buffer = ctx.createBuffer(1, sampleCount, sampleRate);
  const channel = buffer.getChannelData(0);
  const int16ToFloat = 1 / 32768;

  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * Int16Array.BYTES_PER_ELEMENT, true);
    channel[i] = Math.max(-1, Math.min(1, sample * int16ToFloat));
  }

  return buffer;
}

export function stopAudioSource(source: AudioBufferSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    /* source may already be stopped */
  }
}
