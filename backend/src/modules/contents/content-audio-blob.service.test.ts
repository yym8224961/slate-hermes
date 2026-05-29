import { describe, expect, it } from 'bun:test';
import type { BlobService } from '../../infra/blob/blob.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { GroupsService } from '../groups/groups.service';
import { ContentAudioBlobService } from './content-audio-blob.service';

describe('ContentAudioBlobService', () => {
  it('marks missing generated TTS audio as failed instead of silently requeueing', async () => {
    let updateData: Record<string, unknown> | undefined;
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          $queryRaw: async () => [{ id: 'group-1' }],
          content: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              updateData = data;
            },
          },
        }),
    } as unknown as PrismaService;
    const service = new ContentAudioBlobService({} as BlobService, prisma, {
      recomputeManifestEtag: async () => 'etag',
    } as GroupsService);

    await service.handleMissing({
      id: 'content-1',
      groupId: 'group-1',
      audioEtag: 'etag-1',
      audioStatus: 'ready',
      audioSource: 'tts',
      audioText: 'hello',
      audioVoice: 'voice',
    });

    expect(updateData).toMatchObject({
      audioEtag: null,
      audioSize: null,
      audioStatus: 'failed',
      audioLastError: 'TTS 音频文件丢失，请重新生成',
      audioLeaseUntil: null,
    });
    expect(updateData).not.toHaveProperty('audioAttempts');
  });
});
