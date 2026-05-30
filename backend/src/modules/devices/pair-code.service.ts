import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConflictError, InternalError } from '../../common/errors';
import type { PrismaClientLike } from '../../common/db/prisma-client-like';
import { PrismaService } from '../../infra/prisma/prisma.service';

const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_RANDOM_LIMIT =
  Math.floor(256 / PAIR_CODE_ALPHABET.length) * PAIR_CODE_ALPHABET.length;
const PAIR_CODE_MAX_RANDOM_CHUNKS = 32;

@Injectable()
export class PairCodeService {
  constructor(private readonly prisma: PrismaService) {}

  // 6 位字母表：A-Z 去 I/L/O + 2-9。PAIR_CODE_ALPHABET.length^6 约 8.8 亿，
  // 仍按 unique 约束最多重试 8 次以兜底。
  async generateUniquePairCode(client: PrismaClientLike = this.prisma): Promise<string> {
    const batchSize = 8;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidates = uniquePairCodeBatch(batchSize);
      const existing = (await client.device.findMany({
        where: { pairCode: { in: candidates } },
        select: { pairCode: true },
      })) as Array<{ pairCode: string }>;
      const existingCodes = new Set(existing.map((device) => device.pairCode));
      const available = candidates.find((code) => !existingCodes.has(code));
      if (available) return available;
    }
    throw new ConflictError('配对码生成冲突，请重试', { code: 'pair_code_generation_failed' });
  }
}

function generatePairCode(): string {
  let code = '';
  for (let attempts = 0; attempts < PAIR_CODE_MAX_RANDOM_CHUNKS && code.length < 6; attempts++) {
    for (const byte of randomBytes(8)) {
      if (byte >= PAIR_CODE_RANDOM_LIMIT) continue;
      code += PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length];
      if (code.length === 6) break;
    }
  }
  if (code.length !== 6) {
    throw new InternalError('配对码生成失败', { code: 'pair_code_entropy_unavailable' });
  }
  return code;
}

function uniquePairCodeBatch(size: number): string[] {
  const codes = new Set<string>();
  while (codes.size < size) codes.add(generatePairCode());
  return [...codes];
}
