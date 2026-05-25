import { describe, expect, it } from 'bun:test';
import { ContentsService } from './contents.service';

describe('ContentsService current content refresh', () => {
  it('skips timer current-frame refresh after the device manifest changes', async () => {
    let renderCalls = 0;
    const service = new ContentsService(
      {
        device: {
          findUnique: async () => ({
            selectedGroupId: 'group-1',
            selectedGroup: { manifestEtag: 'new-manifest' },
          }),
        },
        content: {
          findUnique: async () => {
            throw new Error('content lookup should be skipped');
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderDynamicContent: async () => {
          renderCalls += 1;
          return { groupEtag: 'rendered-manifest' };
        },
      } as never,
      {} as never
    );

    const result = await service.refreshCurrentContentForDeviceIfDue({
      deviceId: 'device-1',
      groupId: 'group-1',
      seq: 0,
      contentId: 'content-1',
      manifestEtag: 'old-manifest',
    });

    expect(result).toBeNull();
    expect(renderCalls).toBe(0);
  });
});
