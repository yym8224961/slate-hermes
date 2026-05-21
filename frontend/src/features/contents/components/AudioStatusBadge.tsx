import { Loader2 } from 'lucide-react';
import type { ContentAudioStatusT } from 'shared';

interface AudioStatusBadgeProps {
  status: ContentAudioStatusT;
  etag: string | null;
  error?: string | null;
}

export function AudioStatusBadge({ status, etag, error }: AudioStatusBadgeProps) {
  if (status === 'pending' || status === 'generating') {
    return (
      <span
        className="absolute top-2 right-2 bg-paper border border-ink text-ink p-1 pointer-events-none"
        title="音频生成中"
      >
        <Loader2 size={11} className="animate-spin" />
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span
        className="absolute top-2 right-2 bg-paper border border-clay text-clay px-1.5 font-mono text-[10px] pointer-events-none"
        title={error ?? '音频生成失败'}
      >
        !
      </span>
    );
  }

  if (!etag) return null;
  return (
    <span className="absolute top-2 right-2 bg-paper border border-ink text-ink px-1.5 font-mono text-[10px] pointer-events-none">
      ♪
    </span>
  );
}
