import type { Logger } from '@nestjs/common';
import { formatError } from '../../common/utils/error-format';
import { BlobService, type BlobKind } from '../../infra/blob/blob.service';

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
        restoreBlob(this.blob, op.groupId, op.contentId, op.kind, op.previousBytes).catch(
          (err: unknown) => {
            this.logger.warn(
              `Blob rollback failed for ${op.kind} content ${op.contentId} in group ${op.groupId}: ${formatError(err)}`
            );
          }
        )
      )
    );
  }
}

async function restoreBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  kind: BlobKind,
  previousBytes: Buffer | null
): Promise<void> {
  if (previousBytes) await blob.write(groupId, contentId, kind, previousBytes);
  else await blob.delete(groupId, contentId, kind);
}
