import { BlobService } from './blob.service';

export function audioBlobContentId(contentId: string, audioEtag: string): string {
  return `${contentId}.${audioEtag}`;
}

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
