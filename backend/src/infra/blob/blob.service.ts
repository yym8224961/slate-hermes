import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app.config';

export type BlobKind = 'image' | 'audio';

const ext = (kind: BlobKind) => (kind === 'image' ? 'img' : 'pcm');

@Injectable()
export class BlobService {
  constructor(private readonly config: AppConfig) {}

  path(groupId: string, contentId: string, kind: BlobKind): string {
    assertBlobSegment('groupId', groupId);
    assertBlobSegment('contentId', contentId);
    const root = resolve(this.config.blobDir);
    const p = resolve(root, groupId, `${contentId}.${ext(kind)}`);
    const rel = relative(root, p);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('非法 blob 路径');
    }
    return p;
  }

  async write(
    groupId: string,
    contentId: string,
    kind: BlobKind,
    data: Uint8Array | Buffer
  ): Promise<{ path: string; size: number }> {
    const p = this.path(groupId, contentId, kind);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, p);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return { path: p, size: data.byteLength };
  }

  async read(groupId: string, contentId: string, kind: BlobKind): Promise<Buffer | null> {
    try {
      return await readFile(this.path(groupId, contentId, kind));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(groupId: string, contentId: string, kind: BlobKind): Promise<void> {
    try {
      await unlink(this.path(groupId, contentId, kind));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function assertBlobSegment(name: string, value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`非法 blob ${name}`);
  }
}
