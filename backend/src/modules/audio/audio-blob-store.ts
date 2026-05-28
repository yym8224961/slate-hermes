import { BlobService } from '../../infra/blob/blob.service';
import { audioBlobContentId } from './audio-blob-id';

export async function deleteAudioBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  audioEtag: string | null
): Promise<void> {
  if (!audioEtag) return;
  await blob.delete(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
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
