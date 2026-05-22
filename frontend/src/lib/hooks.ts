// 通用自定义 hooks。

import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Inline 改名 hook。
 *
 * @param initialName - 初始名称
 * @param onSave - 保存回调（返回 Promise，reject 表示保存失败）
 * @returns 改名相关的状态和方法
 */
export function useInlineRename(initialName: string, onSave: (name: string) => Promise<void>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const onSaveRef = useRef(onSave);
  const committingRef = useRef(false);
  useEffect(() => {
    onSaveRef.current = onSave;
  });

  // 当 initialName 变化时重置状态
  useEffect(() => {
    setDraft(initialName);
    setEditing(false);
  }, [initialName]);

  const startEditing = useCallback(() => {
    setEditing(true);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraft(initialName);
  }, [initialName]);

  const commit = useCallback(async () => {
    if (committingRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === initialName) {
      setEditing(false);
      setDraft(initialName);
      return;
    }

    committingRef.current = true;
    try {
      await onSaveRef.current(trimmed);
      setEditing(false);
    } catch {
      // 保存失败：保留编辑态和草稿，让用户可以重试或按 Escape 取消
    } finally {
      committingRef.current = false;
    }
  }, [draft, initialName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commit();
      }
      if (e.key === 'Escape') {
        cancelEditing();
      }
    },
    [commit, cancelEditing]
  );

  return {
    editing,
    draft,
    setDraft,
    startEditing,
    cancelEditing,
    commit,
    handleKeyDown,
  };
}
