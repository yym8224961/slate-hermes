// 音频播放预览。server 给的是 raw PCM（16kHz mono 16-bit signed），浏览器
// 不能直接 <audio src> 播，要用 WebAudio 把 PCM 包成 AudioBuffer 播放。

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Pause } from 'lucide-react';
import { useContentAudio } from '@/features/contents/queries';
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

export function AudioPlayPreview({ contentId, etag, className, label }: AudioPlayPreviewProps) {
  const audio = useContentAudio(contentId, etag);
  const [playing, setPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);

  const play = useCallback(() => {
    if (!audio.data || playingRef.current) return;
    // 解析 16-bit signed LE PCM → Float32 [-1,1] AudioBuffer
    const pcm = new Int16Array(audio.data);
    const ctx = ctxRef.current ?? new AudioContext({ sampleRate: SAMPLE_RATE });
    ctxRef.current = ctx;
    const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;

    sourceRef.current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      playingRef.current = false;
      setPlaying(false);
      sourceRef.current = null;
    };
    src.start();
    sourceRef.current = src;
    playingRef.current = true;
    setPlaying(true);
  }, [audio.data]);

  const stop = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    playingRef.current = false;
    setPlaying(false);
  }, []);

  // 组件卸载时停止播放并关闭 AudioContext，避免泄漏（Chromium 限制每标签页 6 个活跃实例）。
  // 对已停止 / 已关闭实例再调一次会抛 InvalidStateError，吞掉即可。
  useEffect(() => {
    return () => {
      try {
        sourceRef.current?.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current = null;
      try {
        void ctxRef.current?.close();
      } catch {
        /* already closed */
      }
      ctxRef.current = null;
    };
  }, []);

  if (!etag) return null;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (audio.isPending || audio.error) return;
        if (playing) stop();
        else play();
      }}
      disabled={audio.isPending || !!audio.error}
      title={playing ? '停止' : '试听'}
      aria-label={playing ? '停止' : '试听'}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1.5 text-stone hover:text-ink hover:bg-cream transition-colors disabled:opacity-50',
        className
      )}
    >
      {playing ? <Pause size={14} /> : <Play size={14} />}
      {label && <span className="font-sans text-[12px]">{label}</span>}
    </button>
  );
}
