import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioSource, ContentAudioStatus } from '@prisma/client';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { GroupsService } from '../groups/groups.service';
import { audioBlobContentId } from '../audio/audio-blob-id';

@Injectable()
export class ContentAudioBlobService {
  private readonly logger = new Logger(ContentAudioBlobService.name);

  constructor(
    private readonly blob: BlobService,
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService
  ) {}

  async delete(groupId: string, contentId: string, audioEtag: string | null): Promise<void> {
    if (!audioEtag) return;
    await this.blob
      .delete(groupId, audioBlobContentId(contentId, audioEtag), 'audio')
      .catch(() => {});
  }

  async read(groupId: string, contentId: string, audioEtag: string | null): Promise<Buffer | null> {
    if (!audioEtag) return null;
    return this.blob.read(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
  }

  async handleMissing(content: {
    id: string;
    groupId: string;
    audioEtag: string | null;
    audioStatus: ContentAudioStatus;
    audioSource: ContentAudioSource | null;
    audioText: string | null;
    audioVoice: string | null;
  }): Promise<void> {
    if (!content.audioEtag) return;

    const data: Prisma.ContentUpdateInput = {
      audioEtag: null,
      audioSize: null,
      audioUpdatedAt: new Date(),
      audioLeaseUntil: null,
    };

    if (content.audioSource === 'tts' && content.audioText && content.audioVoice) {
      data.audioStatus = 'pending';
      data.audioLastError = 'TTS 音频文件丢失，已重新排队';
      data.audioAttempts = 0;
    } else if (content.audioSource === 'upload') {
      data.audioStatus = 'failed';
      data.audioLastError = '上传音频文件丢失，请重新上传';
    } else {
      data.audioStatus = 'none';
      data.audioSource = null;
      data.audioLastError = null;
    }

    await this.prisma.content.update({ where: { id: content.id }, data });
    await this.groups.recomputeManifestEtag(content.groupId);
    this.logger.warn(`missing audio blob repaired content=${content.id}`);
  }
}
