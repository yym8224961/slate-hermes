// 帧编辑器 — 音频选择 dropzone(可选)+ 删除已有音频。

import { useDropzone } from 'react-dropzone';
import { Music, Trash2 } from 'lucide-react';
import { useDeleteFrameAudio } from '../../lib/queries';
import { useConfirm } from '../Confirm';
import { useToast } from '../Toast';
import { cn } from '../../lib/cn';

interface AudioDropzoneProps {
  gid: string;
  /** edit 模式且已有音频时,显示替换+删除入口 */
  hasExistingAudio: boolean;
  /** edit 模式时传 idx,以便删除已有音频 */
  editingSeq: number | null;
  audioFile: File | null;
  onPick: (f: File | null) => void;
}

export function AudioDropzone({
  gid,
  hasExistingAudio,
  editingSeq,
  audioFile,
  onPick,
}: AudioDropzoneProps) {
  const delAudio = useDeleteFrameAudio(gid);
  const confirm = useConfirm();
  const toast = useToast();

  const dz = useDropzone({
    onDrop: (files) => onPick(files[0] ?? null),
    accept: {
      'audio/*': ['.pcm', '.wav', '.raw', '.mp3', '.aac', '.m4a', '.ogg', '.flac', '.wma'],
    },
    maxFiles: 1,
  });

  return (
    <div>
      <p className="font-sans text-[12px] text-stone mb-2 ml-0.5">
        音频{hasExistingAudio ? ' · 已有' : ' · 选填'}
      </p>
      <div
        {...dz.getRootProps()}
        className={cn(
          'border border-dashed rounded-[12px] px-4 py-3 cursor-pointer transition-colors flex items-center gap-3',
          dz.isDragActive
            ? 'border-clay bg-cream-deep'
            : 'border-line hover:border-stone hover:bg-cream'
        )}
      >
        <input {...dz.getInputProps()} />
        <Music size={16} className={audioFile ? 'text-clay' : 'text-stone-light'} />
        <div className="min-w-0 flex-1">
          {audioFile ? (
            <>
              <p className="font-kai text-[13px] text-ink truncate">{audioFile.name}</p>
              <p className="font-sans text-[11px] text-stone">
                {(audioFile.size / 1024).toFixed(1)} KB
              </p>
            </>
          ) : hasExistingAudio ? (
            <p className="font-kai text-[13px] text-stone">拖新文件可替换</p>
          ) : (
            <p className="font-kai text-[13px] text-stone">MP3 / WAV / OGG / FLAC / AAC,自动转码</p>
          )}
        </div>
      </div>

      {hasExistingAudio && editingSeq != null && (
        <button
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: '删除这一帧的音频?',
              description: '图保留,只移除音频文件。',
              destructive: true,
              confirmText: '删除音频',
            });
            if (!ok) return;
            delAudio.mutate(editingSeq, {
              onSuccess: () => toast.success('音频已删除'),
              onError: () => toast.error('删除失败'),
            });
          }}
          disabled={delAudio.isPending}
          className="mt-2 inline-flex items-center gap-1.5 font-sans text-[12px] text-clay hover:underline disabled:opacity-50"
        >
          <Trash2 size={12} />
          删除已有音频
        </button>
      )}
    </div>
  );
}
