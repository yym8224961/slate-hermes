import type { Logger } from '@nestjs/common';
import { BlobService, type BlobKind } from '../../infra/blob/blob.service';
import { formatError } from '../../common/error-format';

interface BlobRollbackOperation {
  groupId: string;
  contentId: string;
  kind: BlobKind;
  previousBytes: Buffer | null;
}

export class BlobRollbackPlan {
  private readonly ops: BlobRollbackOperation[] = [];

  constructor(
    private readonly blob: BlobService,
    private readonly logger: Logger
  ) {}

  restorePrevious(
    groupId: string,
    contentId: string,
    kind: BlobKind,
    previousBytes: Buffer | null
  ): void {
    this.ops.push({ groupId, contentId, kind, previousBytes });
  }

  deleteCreated(groupId: string, contentId: string, kind: BlobKind): void {
    this.restorePrevious(groupId, contentId, kind, null);
  }

  async restoreAll(): Promise<void> {
    await Promise.all(
      this.ops.map((op) =>
        restoreBlob(
          this.blob,
          op.groupId,
          op.contentId,
          op.kind,
          op.previousBytes,
          true,
          this.logger
        ).catch((err: unknown) => {
          this.logger.warn(
            `blob rollback operation failed content=${op.contentId} kind=${op.kind}: ${formatError(err)}`
          );
        })
      )
    );
  }
}

async function restoreBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  kind: BlobKind,
  previousBytes: Buffer | null,
  touched: boolean,
  logger: Logger
): Promise<void> {
  if (!touched) return;
  try {
    if (previousBytes) await blob.write(groupId, contentId, kind, previousBytes);
    else await blob.delete(groupId, contentId, kind);
  } catch (err) {
    logger.warn(`恢复 ${kind} blob 失败 content=${contentId}: ${formatError(err)}`);
    throw err;
  }
}
