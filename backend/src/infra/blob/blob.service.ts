import { Injectable } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AppConfig } from '../config/app.config';

export type BlobKind = 'image' | 'audio';

const ext = (kind: BlobKind) => (kind === 'image' ? 'img' : 'pcm');

@Injectable()
export class BlobService {
  constructor(private readonly config: AppConfig) {}

  path(groupId: string, contentId: string, kind: BlobKind): string {
    const root = resolve(this.config.blobDir);
    const p = resolve(root, groupId, `${contentId}.${ext(kind)}`);
    const rel = relative(root, p);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('非法 blob 路径');
    }
    return p;
  }

  globalPath(contentId: string, kind: BlobKind): string {
    return this.path('_global', contentId, kind);
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

  async writeGlobal(
    contentId: string,
    kind: BlobKind,
    data: Uint8Array | Buffer
  ): Promise<{ path: string; size: number }> {
    const p = this.globalPath(contentId, kind);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    return { path: p, size: data.byteLength };
  }

  async readGlobal(contentId: string, kind: BlobKind): Promise<Buffer | null> {
    try {
      return await readFile(this.globalPath(contentId, kind));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteGlobal(contentId: string, kind: BlobKind): Promise<void> {
    try {
      await unlink(this.globalPath(contentId, kind));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
