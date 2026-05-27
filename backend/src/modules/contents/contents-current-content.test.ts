import { describe, expect, it } from 'bun:test';
import { DASHBOARD_CUSTOM_STARTER_TEMPLATE, DASHBOARD_CUSTOM_STARTER_TEST_DATA } from 'shared';
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

  it('does not reset dashboard pushed data when only refresh interval changes', async () => {
    const currentConfig = {
      type: 'dashboard',
      template: { kind: 'custom', template: DASHBOARD_CUSTOM_STARTER_TEMPLATE },
      test_data: DASHBOARD_CUSTOM_STARTER_TEST_DATA,
      refresh_interval_sec: 600,
    } as const;
    const pushedData = { primary_label: '线上收入', primary_value: '999k' };
    const updateData: Record<string, unknown>[] = [];
    let findCalls = 0;

    const service = new ContentsService(
      {
        content: {
          findUnique: async () => {
            findCalls += 1;
            if (findCalls === 1) {
              return {
                id: 'content-1',
                groupId: 'group-1',
                sortOrder: 0,
                kind: 'dynamic',
                dynamicType: 'dashboard',
                dynamicConfig: currentConfig,
                dynamicData: pushedData,
              };
            }
            return { contentEtag: 'content-etag', audioEtag: null };
          },
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updateData.push(data);
            return {};
          },
        },
      } as never,
      {} as never,
      {
        assertOwned: async () => undefined,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderDynamicContent: async () => ({
          contentId: 'content-1',
          imageEtag: 'image-etag',
          groupEtag: 'group-etag',
          renderedAt: new Date(),
          unchanged: false,
        }),
      } as never,
      {} as never
    );

    await service.patchDynamic('content-1', 'user-1', {
      config: { ...currentConfig, refresh_interval_sec: 1800 },
    });

    expect(updateData[0]).toMatchObject({
      dynamicConfig: { ...currentConfig, refresh_interval_sec: 1800 },
    });
    expect(updateData[0]).not.toHaveProperty('dynamicData');
  });
});
