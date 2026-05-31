import { useCallback, useEffect, useRef, useState } from 'react';
import { pcm16LeToAudioBuffer, stopAudioSource } from '@/features/contents/lib/audio';
import { CONTENT_AUDIO_SAMPLE_RATE, resumeSharedAudioContext } from './sharedAudioContext';

interface UsePcmAudioPlayerOptions {
  onError: (message: string, hint?: string) => void;
}

export function usePcmAudioPlayer({ onError }: UsePcmAudioPlayerOptions) {
  const [playing, setPlaying] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  const startingRef = useRef(false);
  const playbackSeqRef = useRef(0);

  const ensureContext = useCallback(async () => {
    return resumeSharedAudioContext();
  }, []);

  const resetPlaybackState = useCallback(() => {
    playbackSeqRef.current++;
    if (sourceRef.current) {
      sourceRef.current.onended = null;
    }
    sourceRef.current = null;
    startingRef.current = false;
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const stop = useCallback(() => {
    const source = sourceRef.current;
    resetPlaybackState();
    stopAudioSource(source);
  }, [resetPlaybackState]);

  const play = useCallback(
    async (data: ArrayBuffer) => {
      if (playingRef.current || startingRef.current) return;

      const seq = ++playbackSeqRef.current;
      startingRef.current = true;

      let ctx: AudioContext | null;
      try {
        ctx = await ensureContext();
      } catch (err) {
        if (seq !== playbackSeqRef.current) return;
        startingRef.current = false;
        onError('音频播放失败', err instanceof Error ? err.message : undefined);
        return;
      }

      if (seq !== playbackSeqRef.current) return;
      if (!ctx) {
        startingRef.current = false;
        onError('音频播放失败', '当前环境不支持 WebAudio。');
        return;
      }

      let buffer: AudioBuffer;
      try {
        buffer = pcm16LeToAudioBuffer(ctx, data, CONTENT_AUDIO_SAMPLE_RATE);
      } catch (err) {
        startingRef.current = false;
        onError('音频格式异常', err instanceof Error ? err.message : undefined);
        return;
      }

      const previousSource = sourceRef.current;
      if (previousSource) {
        previousSource.onended = null;
        sourceRef.current = null;
        stopAudioSource(previousSource);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (sourceRef.current !== source) return;
        resetPlaybackState();
      };

      try {
        source.start();
      } catch (err) {
        source.disconnect();
        if (seq === playbackSeqRef.current) resetPlaybackState();
        onError('音频播放失败', err instanceof Error ? err.message : undefined);
        return;
      }

      if (seq !== playbackSeqRef.current) {
        source.disconnect();
        stopAudioSource(source);
        return;
      }

      sourceRef.current = source;
      startingRef.current = false;
      playingRef.current = true;
      setPlaying(true);
    },
    [ensureContext, onError, resetPlaybackState]
  );

  useEffect(() => stop, [stop]);

  return { playing, ensureContext, play, stop };
}
