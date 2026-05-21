export function audioBlobContentId(contentId: string, audioEtag: string): string {
  return `${contentId}.${audioEtag}`;
}
