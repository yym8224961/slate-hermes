import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioSource, ContentAudioStatus } from '@prisma/client';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { lockGroupRow } from '../../common/db/row-locks';
import { formatError } from '../../common/utils/error-format';
import { GroupsService } from '../groups/groups.service';
import { deleteContentAudioBlob, readContentAudioBlob } from '../audio/content-audio-blobs';

@Injectable()
export class ContentAudioBlobService {
  private readonly logger = new Logger(ContentAudioBlobService.name);

  constructor(
    private readonly blob: BlobService,
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService
  ) {}

  async delete(groupId: string, contentId: string, audioEtag: string | null): Promise<void> {
    try {
      await deleteContentAudioBlob(this.blob, groupId, contentId, audioEtag);
    } catch (err) {
      this.logger.warn(`delete audio blob failed content=${contentId}: ${formatError(err)}`);
      throw err;
    }
  }

  async read(groupId: string, contentId: string, audioEtag: string | null): Promise<Buffer | null> {
    return readContentAudioBlob(this.blob, groupId, contentId, audioEtag);
  }

  async repairMissingAudioBlob(content: {
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
      data.audioStatus = 'failed';
      data.audioLastError = 'TTS 音频文件丢失，请重新生成';
    } else if (content.audioSource === 'upload') {
      data.audioStatus = 'failed';
      data.audioLastError = '上传音频文件丢失，请重新上传';
    } else {
      data.audioStatus = 'none';
      data.audioSource = null;
      data.audioLastError = null;
    }

    await this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, content.groupId);
      await tx.content.update({ where: { id: content.id }, data });
      await this.groups.recomputeManifestEtag(content.groupId, tx);
    });
    this.logger.warn(`missing audio blob repaired content=${content.id}`);
  }
}
