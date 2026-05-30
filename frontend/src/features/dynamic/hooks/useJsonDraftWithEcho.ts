import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJsonKey } from '@/features/dynamic/model/json';

interface ParsedOk<T> {
  ok: true;
  data: T;
}

interface ParsedErr {
  ok: false;
  error: string;
}

interface UseJsonDraftWithEchoOptions<T> {
  value: T | null;
  parse: (text: string) => ParsedOk<T> | ParsedErr;
  fallback: T;
  onValidChange: (value: T) => void;
}

export function useJsonDraftWithEcho<T>({
  value,
  parse,
  fallback,
  onValidChange,
}: UseJsonDraftWithEchoOptions<T>) {
  const valueKey = useMemo(() => (value ? canonicalJsonKey(value) : null), [value]);
  const [text, setText] = useState(() => JSON.stringify(value ?? fallback, null, 2));
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(text);
  const latestValueRef = useRef(value);
  const pendingEchoKeyRef = useRef<string | null>(null);

  function setDraft(next: string) {
    textRef.current = next;
    setText(next);
  }

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    const latestValue = latestValueRef.current;
    if (!latestValue || !valueKey) return;
    if (pendingEchoKeyRef.current === valueKey) {
      pendingEchoKeyRef.current = null;
      return;
    }
    const local = parse(textRef.current);
    if (local.ok && canonicalJsonKey(local.data) === valueKey) {
      setError(null);
      return;
    }
    setDraft(JSON.stringify(latestValue, null, 2));
    setError(null);
  }, [parse, valueKey]);

  const updateDraft = useCallback(
    (next: string) => {
      setDraft(next);
      const parsed = parse(next);
      setError(parsed.ok ? null : parsed.error);
      if (!parsed.ok) return;
      const parsedKey = canonicalJsonKey(parsed.data);
      if (parsedKey === valueKey) return;
      pendingEchoKeyRef.current = parsedKey;
      onValidChange(parsed.data);
    },
    [onValidChange, parse, valueKey]
  );

  return { text, error, setError, updateDraft };
}
