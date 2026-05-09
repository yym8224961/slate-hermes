import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** sha256 前 32 字符；与 _legacy 行为一致。 */
export function computeETag(buf: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

/**
 * If-None-Match 与裸 etag 比对。容忍 `"abc"` / `abc` 两种格式 + `*`。
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const list = ifNoneMatch.split(',').map((s) => s.trim().replace(/^W?\/?"?(.*?)"?$/, '$1'));
  return list.includes(etag) || list.includes('*');
}

/**
 * 把二进制资源（带 etag）写入 fastify reply。命中 If-None-Match 即 304 + 空 body。
 */
export function respondWithEtag(
  req: FastifyRequest,
  reply: FastifyReply,
  etag: string,
  body: Buffer | Uint8Array,
  contentType: string
): void {
  const headerEtag = `"${etag}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  const ifNm = typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined;

  void reply.header('ETag', headerEtag).header('Cache-Control', 'private, must-revalidate');

  if (etagMatches(ifNm, etag)) {
    void reply.status(304).send();
    return;
  }
  void reply
    .status(200)
    .header('Content-Type', contentType)
    .header('Content-Length', String(body.byteLength))
    .send(Buffer.isBuffer(body) ? body : Buffer.from(body));
}
