// 音频播放预览。server 给的是 raw PCM（16kHz mono 16-bit signed），浏览器
// 不能直接 <audio src> 播，要用 WebAudio 把 PCM 包成 AudioBuffer 播放。

import { useState, useRef, useCallback, useEffect } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { useContentAudio } from '@/features/contents/queries';
import { useToast } from '@/components/feedback/useToast';
import { cn } from '@/lib/cn';
import { CONTENT_AUDIO_SAMPLE_RATE, resumeSharedAudioContext } from './sharedAudioContext';

interface AudioPlayPreviewProps {
  contentId: string;
  /** 没 etag 表示无音频,组件返 null */
  etag: string | null;
  className?: string;
  /** 标签：显示在按钮旁（可选，如「试听」） */
  label?: string;
}

function stopSource(source: AudioBufferSourceNode | null) {
  if (!source) return;
  try {
    source.stop();
  } catch {
    /* source may already be stopped */
  }
}

export function AudioPlayPreview({ contentId, etag, className, label }: AudioPlayPreviewProps) {
  const [requested, setRequested] = useState(false);
  const [playAfterLoad, setPlayAfterLoad] = useState(false);
  const audio = useContentAudio(contentId, etag, requested);
  const [playing, setPlaying] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  const startingRef = useRef(false);
  const playbackSeqRef = useRef(0);
  const toast = useToast();

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
    stopSource(source);
  }, [resetPlaybackState]);

  const play = useCallback(
    async (data: ArrayBuffer) => {
      if (playingRef.current || startingRef.current) return;
      if (data.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
        toast.error('音频格式异常', 'PCM 数据长度不是 16-bit 对齐。');
        return;
      }
      // 解析 16-bit signed LE PCM -> Float32 [-1,1] AudioBuffer
      const pcm = new Int16Array(data);
      const seq = ++playbackSeqRef.current;
      startingRef.current = true;
      let ctx: AudioContext | null;
      try {
        ctx = await ensureContext();
      } catch (err) {
        if (seq !== playbackSeqRef.current) return;
        startingRef.current = false;
        toast.error('音频播放失败', err instanceof Error ? err.message : undefined);
        return;
      }
      if (seq !== playbackSeqRef.current) return;
      if (!ctx) {
        startingRef.current = false;
        toast.error('音频播放失败', '当前环境不支持 WebAudio。');
        return;
      }
      const buf = ctx.createBuffer(1, pcm.length, CONTENT_AUDIO_SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      const int16ToFloat = 1 / 32768;
      for (let i = 0; i < pcm.length; i++) {
        const sample = pcm[i]!;
        ch[i] = Math.max(-1, Math.min(1, sample * int16ToFloat));
      }

      const previousSource = sourceRef.current;
      if (previousSource) {
        previousSource.onended = null;
        sourceRef.current = null;
        stopSource(previousSource);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        if (sourceRef.current !== src) return;
        resetPlaybackState();
      };
      try {
        src.start();
      } catch (err) {
        src.disconnect();
        if (seq === playbackSeqRef.current) resetPlaybackState();
        toast.error('音频播放失败', err instanceof Error ? err.message : undefined);
        return;
      }
      if (seq !== playbackSeqRef.current) {
        src.disconnect();
        stopSource(src);
        return;
      }
      sourceRef.current = src;
      startingRef.current = false;
      playingRef.current = true;
      setPlaying(true);
    },
    [ensureContext, resetPlaybackState, toast]
  );

  useEffect(() => {
    if (!playAfterLoad || !audio.data) return;
    setPlayAfterLoad(false);
    void play(audio.data);
  }, [audio.data, play, playAfterLoad]);

  useEffect(() => {
    if (audio.error) setPlayAfterLoad(false);
  }, [audio.error]);

  useEffect(() => {
    stop();
    setRequested(false);
    setPlayAfterLoad(false);
  }, [contentId, etag, stop]);

  // 组件卸载时只停止自己的 source；AudioContext 是全局单例，避免内容卡多时触发
  // Chromium 每标签页活跃 AudioContext 数量限制。
  useEffect(() => {
    return stop;
  }, [stop]);

  if (!etag) return null;

  const loading = requested && audio.isFetching;
  const title = audio.error ? '音频加载失败' : loading ? '加载中' : playing ? '停止' : '试听';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (loading || audio.error) return;
        if (playing) {
          setPlayAfterLoad(false);
          stop();
          return;
        }
        if (audio.data) {
          void play(audio.data);
        } else {
          setRequested(true);
          setPlayAfterLoad(true);
          void ensureContext()
            .then((ctx) => {
              if (ctx) return;
              setPlayAfterLoad(false);
              toast.error('音频播放失败', '当前环境不支持 WebAudio。');
            })
            .catch((err) => {
              setPlayAfterLoad(false);
              toast.error('音频播放失败', err instanceof Error ? err.message : undefined);
            });
        }
      }}
      disabled={loading || !!audio.error}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1.5 text-stone hover:text-ink hover:bg-cream transition-colors disabled:opacity-50',
        className
      )}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : playing ? (
        <Pause size={14} />
      ) : (
        <Play size={14} />
      )}
      {label && <span className="font-sans text-[12px]">{label}</span>}
    </button>
  );
}
