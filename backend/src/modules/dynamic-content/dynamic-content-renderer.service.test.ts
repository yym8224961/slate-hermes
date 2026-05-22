import { describe, expect, it } from 'bun:test';
import { FRAME_BYTES } from 'shared';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { BlobService } from '../../infra/blob/blob.service';
import type { GroupsService } from '../groups/groups.service';
import type { DynamicFrameRendererService } from '../frame-renderer/dynamic-frame-renderer.service';
import type { DynamicAudioService } from './audio/dynamic-audio.service';
import type { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';

describe('DynamicContentRendererService queueing', () => {
  it('does not run a scheduled render queued behind a failed force render', async () => {
    const first = deferred<unknown>();
    let fetchCalls = 0;
    const service = createService(() => {
      fetchCalls++;
      return first.promise;
    });

    const forceRender = service.renderDynamicContent('content-1', { force: true });
    const scheduledRender = service.renderDynamicContent('content-1');

    first.reject(new Error('provider down'));

    await expect(forceRender).rejects.toThrow('provider down');
    await expect(scheduledRender).rejects.toThrow('provider down');
    expect(fetchCalls).toBe(1);
  });

  it('still runs a force render queued behind a failed force render', async () => {
    const first = deferred<unknown>();
    let fetchCalls = 0;
    const service = createService(() => {
      fetchCalls++;
      if (fetchCalls === 1) return first.promise;
      return Promise.resolve({ tempC: 21 });
    });

    const failedRender = service.renderDynamicContent('content-1', { force: true });
    const forceRender = service.renderDynamicContent('content-1', { force: true });

    first.reject(new Error('provider down'));

    await expect(failedRender).rejects.toThrow('provider down');
    await expect(forceRender).resolves.toMatchObject({
      contentId: 'content-1',
      groupEtag: 'group-etag',
      unchanged: false,
    });
    expect(fetchCalls).toBe(2);
  });
});

function createService(fetchData: () => Promise<unknown>): DynamicContentRendererService {
  const content = {
    id: 'content-1',
    groupId: 'group-1',
    frameName: null,
    kind: 'dynamic',
    dynamicType: 'weather',
    dynamicConfig: {},
    dynamicData: null,
    dynamicNextRunAt: null,
    imageEtag: 'old-image-etag',
    imageSize: 0,
  };
  const prisma = {
    content: {
      findUnique: async () => content,
      update: async () => content,
    },
  };
  const blob = {
    read: async () => null,
    write: async () => undefined,
    delete: async () => undefined,
  };
  const registry = {
    get: () => ({
      type: 'weather',
      definition: { default_ttl_sec: 300 },
      provider: {
        type: 'weather',
        validateConfig: () => ({}),
        fetchData,
      },
    }),
    defaultTtlSec: () => 300,
  };
  const frameRenderer = {
    render: async () => Buffer.alloc(FRAME_BYTES, 0xff),
  };
  const groups = {
    recomputeManifestEtag: async () => 'group-etag',
  };
  const dynamicAudio = {
    sync: async () => false,
  };
  return new DynamicContentRendererService(
    prisma as unknown as PrismaService,
    blob as unknown as BlobService,
    registry as unknown as DynamicContentRegistry,
    frameRenderer as unknown as DynamicFrameRendererService,
    groups as unknown as GroupsService,
    dynamicAudio as unknown as DynamicAudioService
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (err: Error) => void;
} {
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((_, rejectFn) => {
    reject = rejectFn;
  });
  return { promise, reject };
}
