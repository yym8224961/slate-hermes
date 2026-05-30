import { describe, expect, it } from 'bun:test';
import { DevicesProtocolController } from './devices-protocol.controller';

describe('DevicesProtocolController', () => {
  it('returns the service-normalized MAC address in register responses', async () => {
    const controller = new DevicesProtocolController(
      {
        registerOrReset: async () => ({
          deviceId: 'device-1',
          deviceSecret: 'a'.repeat(64),
          pairCode: 'ABC123',
          reclaimed: false,
          serverTime: '2026-05-28T00:00:00.000Z',
        }),
      } as never,
      {} as never
    );

    await expect(controller.register({ mac: 'aa-bb-cc-dd-ee-ff' })).resolves.toMatchObject({
      mac: 'AA:BB:CC:DD:EE:FF',
    });
  });

  it('delegates poll handling to DevicesService', async () => {
    let receivedDeviceId: string | null = null;
    let receivedTelemetry: unknown;
    const controller = new DevicesProtocolController({
      poll: async (deviceId: string, telemetry: unknown) => {
        receivedDeviceId = deviceId;
        receivedTelemetry = telemetry;
        return {
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
          current_content: null,
        };
      },
    } as never);

    const telemetry = {
      wake_reason: 'button',
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'manifest-1',
    };
    const state = await controller.poll({ deviceId: 'device-1', mac: 'AA:BB:CC:DD:EE:FF' }, {
      telemetry,
    } as never);

    expect(receivedDeviceId).toBe('device-1');
    expect(receivedTelemetry).toEqual(telemetry);
    expect(state.current_content).toBeNull();
  });
});
