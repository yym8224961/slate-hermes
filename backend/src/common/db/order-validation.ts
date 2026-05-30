import { ValidationError } from '../errors';

interface OrderValidationMessages {
  duplicateMessage?: string;
  duplicateCode?: string;
  unknownMessage?: string;
  unknownCode?: string;
  missingMessage?: string;
  missingCode?: string;
  mismatchMessage?: string;
  mismatchCode?: string;
}

export function validateOrderSet(
  allIds: Iterable<string>,
  order: string[],
  messages: OrderValidationMessages = {}
): void {
  const allIdSet = allIds instanceof Set ? allIds : new Set(allIds);
  const orderSet = new Set(order);
  if (orderSet.size !== order.length) {
    throw new ValidationError(messages.duplicateMessage ?? '排序列表不能包含重复 ID', {
      code: messages.duplicateCode ?? messages.mismatchCode ?? 'order_duplicate',
    });
  }

  const unknownIds = order.filter((id) => !allIdSet.has(id));
  if (unknownIds.length > 0) {
    throw new ValidationError(
      messages.unknownMessage ?? messages.mismatchMessage ?? '排序列表包含未知 ID',
      {
        code: messages.unknownCode ?? messages.mismatchCode ?? 'order_unknown',
      }
    );
  }

  if (order.length !== allIdSet.size) {
    throw new ValidationError(
      messages.missingMessage ?? messages.mismatchMessage ?? '排序列表未覆盖全部 ID',
      {
        code: messages.missingCode ?? messages.mismatchCode ?? 'order_missing',
      }
    );
  }
}
