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

  it('changes dynamic content etags when config or pushed data changes', () => {
    const group = {
      ...groupInput('previous-etag'),
      contents: [
        {
          ...groupInput('previous-etag').contents[0]!,
          kind: 'dynamic' as const,
          dynamicType: 'dashboard',
          frameName: '外部数据',
          dynamicConfig: {
            type: 'dashboard',
            refresh_interval_sec: 600,
            template: { kind: 'system', id: 'ai_usage_stats' },
          },
          dynamicData: { total_requests: 1, balance: 10 },
        },
      ],
    };

    const before = computeGroupEtags(group);
    const afterConfig = computeGroupEtags({
      ...group,
      contents: [
        {
          ...group.contents[0]!,
          dynamicConfig: {
            type: 'dashboard',
            refresh_interval_sec: 1200,
            template: { kind: 'system', id: 'ai_usage_stats' },
          },
        },
      ],
    });
    const afterData = computeGroupEtags({
      ...group,
      contents: [
        {
          ...group.contents[0]!,
          dynamicData: { total_requests: 2, balance: 10 },
        },
      ],
    });

    expect(afterConfig.contentEtags[0]!.etag).not.toBe(before.contentEtags[0]!.etag);
    expect(afterData.contentEtags[0]!.etag).not.toBe(before.contentEtags[0]!.etag);
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
