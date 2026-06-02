import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app.config';
import { formatError } from '../../common/utils/error-format';
import { ValidationError } from '../../common/errors';
import { eachLimit } from '../../common/utils/each-limit';
import { KeyedPromiseQueue } from '../../common/worker/keyed-promise-queue';

export type BlobKind = 'image' | 'audio';

const ext = (kind: BlobKind) => (kind === 'image' ? 'img' : 'pcm');
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES: Record<BlobKind, number> = {
  image: 64 * 1024,
  audio: 5 * 1024 * 1024,
};

@Injectable()
export class BlobService implements OnModuleInit {
  private readonly logger = new Logger(BlobService.name);
  private readonly writeQueue = new KeyedPromiseQueue();
  private blobRoot: string | null = null;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.config.blobDir, { recursive: true });
    this.blobRoot = realpathSync(this.config.blobDir);
    await this.cleanupStaleTmpFiles().catch((err: unknown) => {
      this.logger.warn(`Failed to clean stale blob temporary files: ${formatError(err)}`);
    });
  }

  path(groupId: string, contentId: string, kind: BlobKind): string {
    assertBlobSegment('groupId', groupId);
    assertBlobSegment('contentId', contentId);
    const root = this.blobRoot ?? resolve(this.config.blobDir);
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
    assertBlobSize(kind, data.byteLength);
    return this.runExclusive(this.blobKey(groupId, contentId, kind), () =>
      this.writeExclusive(groupId, contentId, kind, data)
    );
  }

  private async writeExclusive(
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
      await unlink(tmp).catch((cleanupErr: unknown) => {
        this.logger.warn(
          `Failed to remove blob temporary file at ${tmp}: ${formatError(cleanupErr)}`
        );
      });
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
    return this.runExclusive(this.blobKey(groupId, contentId, kind), async () => {
      await this.deleteExclusive(groupId, contentId, kind);
    });
  }

  private async deleteExclusive(groupId: string, contentId: string, kind: BlobKind): Promise<void> {
    try {
      await unlink(this.path(groupId, contentId, kind));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private blobKey(groupId: string, contentId: string, kind: BlobKind): string {
    return `${groupId}:${contentId}:${kind}`;
  }

  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.writeQueue.run(key, fn);
  }

  private async cleanupStaleTmpFiles(): Promise<void> {
    const root = this.blobRoot ?? resolve(this.config.blobDir);
    const cutoff = Date.now() - TMP_MAX_AGE_MS;
    await cleanupTmpFilesUnder(root, cutoff, this.logger);
  }
}

function assertBlobSegment(name: string, value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`非法 blob ${name}`);
  }
}

function assertBlobSize(kind: BlobKind, size: number): void {
  const max = MAX_BLOB_BYTES[kind];
  if (size > max) {
    throw new ValidationError(
      `${kind === 'image' ? '图片' : '音频'} blob 不能超过 ${Math.floor(max / 1024)}KB`,
      {
        code: 'blob_too_large',
        kind,
        max_bytes: max,
      }
    );
  }
}

async function cleanupTmpFilesUnder(dir: string, cutoff: number, logger: Logger): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  await eachLimit(entries, 16, async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanupTmpFilesUnder(path, cutoff, logger);
      return;
    }
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) return;
    const info = await stat(path).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Failed to inspect blob temporary file at ${path}: ${formatError(err)}`);
      }
      return null;
    });
    if (!info || info.mtimeMs > cutoff) return;
    await unlink(path).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Failed to remove stale blob temporary file at ${path}: ${formatError(err)}`);
      }
    });
  });
}
