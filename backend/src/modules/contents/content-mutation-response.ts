import type { ContentMutationResponseT } from 'shared';

export function toContentMutationResponse(
  contentId: string,
  seq: number,
  imageEtag: string,
  audioEtag: string | null,
  groupEtag: string,
  contentEtag: string
): ContentMutationResponseT {
  return {
    id: contentId,
    seq,
    content_etag: contentEtag,
    image_etag: imageEtag,
    audio_etag: audioEtag,
    manifest_etag: groupEtag,
  };
}
