import { describe, expect, it } from 'bun:test';
import type { ContentSummaryT } from 'shared';
import { DevicesProtocolController } from './devices-protocol.controller';

describe('DevicesProtocolController', () => {
  it('returns current_content for non-timer polls when the reported manifest still matches', async () => {
    let refreshCalls = 0;
    const currentRequest = {
      deviceId: 'device-1',
      groupId: 'group-1',
      seq: 2,
      contentId: 'content-1',
      manifestEtag: 'manifest-1',
    };
    const currentContent: ContentSummaryT = {
      id: 'content-1',
      seq: 2,
      content_etag: 'content-etag',
      frame_name: 'Frame',
      device_status_bar_text: 'Frame',
      image_etag: 'image-etag',
      audio_etag: null,
      image_size: 100,
      audio_size: null,
      audio_status: 'none',
      audio_source: null,
      audio_voice: null,
      kind: 'image',
      dynamic_type: null,
      next_wake_sec: null,
    };
    const controller = new DevicesProtocolController(
      {
        recordTelemetry: async () => ({
          id: 'device-1',
          mac: 'AA:BB:CC:DD:EE:FF',
          name: null,
          ownerUserId: 'user-1',
          selectedGroupId: 'group-1',
          pairCode: 'ABC123',
          selectedGroup: { manifestEtag: 'manifest-1' },
        }),
        buildState: async () => ({
          device: {
            id: 'device-1',
            mac: 'AA:BB:CC:DD:EE:FF',
            name: null,
            bound: true,
            pair_code: null,
            server_time: '2026-05-28T00:00:00.000Z',
          },
          group: {
            id: 'group-1',
            structure_etag: 'structure-1',
            manifest_etag: 'manifest-1',
            name: 'Group',
            content_count: 3,
            sort_order: 0,
            position: { current: 1, total: 1 },
          },
        }),
      } as never,
      {} as never,
      {
        resolveCurrentContentRequest: async () => currentRequest,
        refreshCurrentContentForDeviceIfDue: async () => {
          refreshCalls += 1;
          return currentRequest;
        },
        currentContentForDevice: async () => currentContent,
      } as never
    );

    const state = await controller.poll({ deviceId: 'device-1', mac: 'AA:BB:CC:DD:EE:FF' }, {
      telemetry: {
        wake_reason: 'button',
        current_group: 'group-1',
        current_content_seq: 2,
        manifest_etag: 'manifest-1',
      },
    } as never);

    expect(refreshCalls).toBe(0);
    expect(state.current_content).toEqual(currentContent);
  });
});
