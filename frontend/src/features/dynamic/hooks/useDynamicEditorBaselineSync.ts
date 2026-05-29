import { useEffect, useMemo, useRef, useState } from 'react';
import type { DynamicConfigT, DynamicTypeT } from 'shared';
import {
  createDynamicEditorBaseline,
  isSameDynamicEditorBaseline,
  type DynamicEditorBaseline,
} from '@/features/dynamic/model/editor-baseline';

interface DynamicEditorState {
  baseline: DynamicEditorBaseline;
  type: DynamicTypeT;
  frameName: string;
  configKey: string;
}

export function useDynamicEditorBaselineSync({
  contentId,
  serverType,
  serverFrameName,
  serverConfig,
  type,
  frameName,
  configKey,
  setType,
  setFrameName,
  setConfig,
}: {
  contentId: string;
  serverType: DynamicTypeT;
  serverFrameName: string | null;
  serverConfig: DynamicConfigT;
  type: DynamicTypeT;
  frameName: string;
  configKey: string;
  setType: (type: DynamicTypeT) => void;
  setFrameName: (frameName: string) => void;
  setConfig: (config: DynamicConfigT) => void;
}) {
  const [baseline, setBaseline] = useState(() =>
    createDynamicEditorBaseline(contentId, serverType, serverFrameName, serverConfig)
  );
  const serverBaseline = useMemo(
    () => createDynamicEditorBaseline(contentId, serverType, serverFrameName, serverConfig),
    [contentId, serverConfig, serverFrameName, serverType]
  );
  const lastSyncedServerKeyRef = useRef('');
  const editorStateRef = useRef<DynamicEditorState>({ baseline, type, frameName, configKey });

  useEffect(() => {
    editorStateRef.current = { baseline, type, frameName, configKey };
  }, [baseline, configKey, frameName, type]);

  useEffect(() => {
    const serverKey = [
      serverBaseline.contentId,
      serverBaseline.type,
      serverBaseline.frameName,
      serverBaseline.configKey,
    ].join('\0');
    if (lastSyncedServerKeyRef.current === serverKey) return;

    const {
      baseline: currentBaseline,
      type: currentType,
      frameName: currentFrameName,
      configKey: currentConfigKey,
    } = editorStateRef.current;
    const hasLocalEdits =
      currentBaseline.contentId === serverBaseline.contentId &&
      (currentType !== currentBaseline.type ||
        currentFrameName !== currentBaseline.frameName ||
        currentConfigKey !== currentBaseline.configKey);
    const localMatchesServer =
      currentType === serverBaseline.type &&
      currentFrameName === serverBaseline.frameName &&
      currentConfigKey === serverBaseline.configKey;

    if (hasLocalEdits && !localMatchesServer) {
      if (!isSameDynamicEditorBaseline(currentBaseline, serverBaseline)) {
        setBaseline(serverBaseline);
      }
      lastSyncedServerKeyRef.current = serverKey;
      return;
    }

    if (!isSameDynamicEditorBaseline(currentBaseline, serverBaseline)) setBaseline(serverBaseline);
    if (currentType !== serverBaseline.type) setType(serverBaseline.type);
    if (currentFrameName !== serverBaseline.frameName) setFrameName(serverBaseline.frameName);
    if (currentConfigKey !== serverBaseline.configKey) setConfig(serverConfig);
    lastSyncedServerKeyRef.current = serverKey;
  }, [serverBaseline, serverConfig, setConfig, setFrameName, setType]);

  return { baseline, setBaseline };
}
