import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from 'react';

export function useInlineRename(initialName: string, onSave: (name: string) => Promise<void>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const onSaveRef = useRef(onSave);
  const committingRef = useRef(false);

  useLayoutEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

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
      // Keep edit mode and the draft so the user can retry or cancel with Escape.
    } finally {
      committingRef.current = false;
    }
  }, [draft, initialName]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void commit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
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
