import { BlobService } from '../../infra/blob/blob.service';
import { audioBlobContentId } from './audio-blob-id';

export async function deleteContentAudioBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  audioEtag: string | null
): Promise<void> {
  if (!audioEtag) return;
  await blob.delete(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
}

export async function readContentAudioBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  audioEtag: string | null
): Promise<Buffer | null> {
  if (!audioEtag) return null;
  return blob.read(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
}
