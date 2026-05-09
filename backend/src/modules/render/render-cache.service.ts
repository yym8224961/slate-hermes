import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppConfig } from '../../infra/config/app.config';

export interface CacheKeyParts {
  sourceEtag: string;
  width: number;
  height: number;
  threshold: number;
  mode: string;
  autoInvert: boolean;
  letterbox: boolean;
}

@Injectable()
export class RenderCacheService {
  private readonly logger = new Logger(RenderCacheService.name);
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(private readonly config: AppConfig) {}

  key(parts: CacheKeyParts): string {
    const raw = [
      parts.sourceEtag,
      parts.width,
      parts.height,
      parts.threshold,
      parts.mode,
      parts.autoInvert ? 1 : 0,
      parts.letterbox ? 1 : 0,
    ].join('|');
    return createHash('sha1').update(raw).digest('hex');
  }

  /** {BLOB_DIR}/render-cache/{key0..2}/{key}.bin —— 两层 hex 前缀避免单目录爆 inode */
  path(key: string): string {
    return join(this.config.blobDir, 'render-cache', key.slice(0, 2), `${key}.bin`);
  }

  async tryRead(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  /**
   * 命中缓存直接返；未命中调 compute() 算并落盘。
   * 同 key 并发时只跑一次 compute。
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<Buffer>
  ): Promise<{ data: Buffer; fromCache: boolean }> {
    const hit = await this.tryRead(key);
    if (hit) return { data: hit, fromCache: true };

    const flight = this.inFlight.get(key);
    if (flight) {
      const data = await flight;
      return { data, fromCache: true };
    }

    const promise = (async () => {
      try {
        const data = await compute();
        await this.write(key, data);
        return data;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    const data = await promise;
    return { data, fromCache: false };
  }

  /** 按 atime 清掉 maxAgeDays 之前的条目（cron-friendly，不在请求路径上调）。 */
  async gc(maxAgeDays: number): Promise<{ removed: number }> {
    const root = join(this.config.blobDir, 'render-cache');
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      await stat(root);
    } catch {
      return { removed: 0 };
    }
    const { readdir, unlink } = await import('node:fs/promises');
    for (const prefix of await readdir(root)) {
      const dir = join(root, prefix);
      for (const file of await readdir(dir).catch(() => [])) {
        const fp = join(dir, file);
        try {
          const s = await stat(fp);
          if (s.atimeMs < cutoff) {
            await unlink(fp);
            removed++;
          }
        } catch {
          /* skip */
        }
      }
    }
    this.logger.log(`render-cache gc removed ${removed} entries (older than ${maxAgeDays}d)`);
    return { removed };
  }
}
