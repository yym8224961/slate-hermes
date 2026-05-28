// 音频播放预览。server 给的是 raw PCM（16kHz mono 16-bit signed），浏览器
// 不能直接 <audio src> 播，要用 WebAudio 把 PCM 包成 AudioBuffer 播放。

import { useState, useRef, useCallback, useEffect } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { useContentAudio } from '@/features/contents/queries';
import { useToast } from '@/components/feedback/Toast';
import { cn } from '@/lib/cn';

interface AudioPlayPreviewProps {
  contentId: string;
  /** 没 etag 表示无音频,组件返 null */
  etag: string | null;
  className?: string;
  /** 标签：显示在按钮旁（可选，如「试听」） */
  label?: string;
}

const SAMPLE_RATE = 16000;
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return sharedAudioContext;
}

function stopSource(source: AudioBufferSourceNode | null) {
  if (!source) return;
  try {
    source.stop();
  } catch {
    /* source may already be stopped */
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void sharedAudioContext?.close().catch(() => {});
    sharedAudioContext = null;
  });
}

export function AudioPlayPreview({ contentId, etag, className, label }: AudioPlayPreviewProps) {
  const [requested, setRequested] = useState(false);
  const [playAfterLoad, setPlayAfterLoad] = useState(false);
  const audio = useContentAudio(contentId, etag, requested);
  const [playing, setPlaying] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  const toast = useToast();

  const ensureContext = useCallback(() => {
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  }, []);

  const resetPlaybackState = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.onended = null;
    }
    sourceRef.current = null;
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const stop = useCallback(() => {
    const source = sourceRef.current;
    resetPlaybackState();
    stopSource(source);
  }, [resetPlaybackState]);

  const play = useCallback(
    (data: ArrayBuffer) => {
      if (playingRef.current) return;
      if (data.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
        toast.error('音频格式异常', 'PCM 数据长度不是 16-bit 对齐。');
        return;
      }
      // 解析 16-bit signed LE PCM -> Float32 [-1,1] AudioBuffer
      const pcm = new Int16Array(data);
      const ctx = ensureContext();
      if (!ctx) {
        toast.error('音频播放失败', '当前环境不支持 WebAudio。');
        return;
      }
      const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      const int16ToFloat = 1 / 32768;
      for (let i = 0; i < pcm.length; i++) {
        const sample = pcm[i]!;
        ch[i] = Math.max(-1, Math.min(1, sample * int16ToFloat));
      }

      stop();
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
        resetPlaybackState();
        toast.error('音频播放失败', err instanceof Error ? err.message : undefined);
        return;
      }
      sourceRef.current = src;
      playingRef.current = true;
      setPlaying(true);
    },
    [ensureContext, resetPlaybackState, stop, toast]
  );

  useEffect(() => {
    if (!playAfterLoad || !audio.data) return;
    setPlayAfterLoad(false);
    play(audio.data);
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
    return () => {
      const source = sourceRef.current;
      if (source) {
        source.onended = null;
      }
      sourceRef.current = null;
      playingRef.current = false;
      stopSource(source);
    };
  }, []);

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
        ensureContext();
        if (audio.data) {
          play(audio.data);
        } else {
          setRequested(true);
          setPlayAfterLoad(true);
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
