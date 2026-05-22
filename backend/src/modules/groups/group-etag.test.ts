import { describe, expect, it } from 'bun:test';
import { computeGroupEtags, type GroupEtagInput } from './group-etag';

describe('computeGroupEtags', () => {
  it('keeps the same content etag for unchanged rows', () => {
    const group = groupInput('previous-etag');
    const first = computeGroupEtags(group);
    const second = computeGroupEtags({
      ...group,
      contents: [{ ...group.contents[0]!, contentEtag: first.contentEtags[0]!.etag }],
    });

    expect(second.contentEtags[0]!.etag).toBe(first.contentEtags[0]!.etag);
    expect(second.contentEtags[0]!.previousEtag).toBe(first.contentEtags[0]!.etag);
    expect(second.manifestEtag).toBe(first.manifestEtag);
  });

  it('changes the content etag when manifest-visible fields change', () => {
    const group = groupInput('previous-etag');
    const before = computeGroupEtags(group);
    const after = computeGroupEtags({
      ...group,
      contents: [{ ...group.contents[0]!, frameName: 'New Name' }],
    });

    expect(after.contentEtags[0]!.etag).not.toBe(before.contentEtags[0]!.etag);
    expect(after.manifestEtag).not.toBe(before.manifestEtag);
  });
});

function groupInput(contentEtag: string): GroupEtagInput {
  return {
    name: 'Group',
    sortOrder: 0,
    contents: [
      {
        id: 'content-1',
        sortOrder: 0,
        kind: 'image',
        dynamicType: null,
        imageEtag: 'image-etag',
        imageSize: 100,
        audioEtag: null,
        audioSize: null,
        audioStatus: 'none',
        audioSource: null,
        audioVoice: null,
        frameName: 'Frame',
        dynamicConfig: null,
        dynamicData: null,
        dynamicLastRunAt: null,
        contentEtag,
      },
    ],
  };
}
