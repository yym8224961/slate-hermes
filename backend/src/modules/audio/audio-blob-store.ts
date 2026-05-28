import type { Logger } from '@nestjs/common';
import { BlobService } from '../../infra/blob/blob.service';
import { formatError } from '../../common/utils';
import { audioBlobContentId } from './audio-blob-id';

export async function deleteAudioBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  audioEtag: string | null,
  logger?: Logger
): Promise<void> {
  if (!audioEtag) return;
  try {
    await blob.delete(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
  } catch (err) {
    logger?.warn(`delete audio blob failed content=${contentId}: ${formatError(err)}`);
    throw err;
  }
}

export async function readAudioBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  audioEtag: string | null
): Promise<Buffer | null> {
  if (!audioEtag) return null;
  return blob.read(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
}
