import { Injectable } from '@nestjs/common';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppConfig } from '../config/app.config';

export type BlobKind = 'image' | 'audio';

const ext = (kind: BlobKind) => (kind === 'image' ? 'img' : 'pcm');

@Injectable()
export class BlobService {
  constructor(private readonly config: AppConfig) {}

  path(groupId: string, contentId: string, kind: BlobKind): string {
    return join(this.config.blobDir, groupId, `${contentId}.${ext(kind)}`);
  }

  async write(
    groupId: string,
    contentId: string,
    kind: BlobKind,
    data: Uint8Array | Buffer
  ): Promise<{ path: string; size: number }> {
    const p = this.path(groupId, contentId, kind);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
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

  async exists(groupId: string, contentId: string, kind: BlobKind): Promise<boolean> {
    try {
      await stat(this.path(groupId, contentId, kind));
      return true;
    } catch {
      return false;
    }
  }
}
