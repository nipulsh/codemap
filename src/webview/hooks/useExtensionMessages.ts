import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionToWebview, WebviewToExtension } from '../../../shared/messages';
import { safeParseExtensionToWebview } from '../../../shared/messages';
import {
  applyGraphPatch,
  type GraphPatch,
  type GraphSnapshot,
} from '../../../shared/graph';

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (msg: unknown) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    };
  }
}

const vscodeApi = window.acquireVsCodeApi?.();

export function postToExtension(message: WebviewToExtension): void {
  vscodeApi?.postMessage(message);
}

function mergePatch(
  snapshot: GraphSnapshot,
  patch: GraphPatch,
): GraphSnapshot {
  return applyGraphPatch(snapshot, patch);
}

export function useExtensionMessages(): {
  snapshot: GraphSnapshot | null;
  lastPatch: GraphPatch | null;
  fullVersion: number;
  progress: string | null;
  error: string | null;
  layoutEngine: string | null;
  setLayoutEngine: (engine: string | null) => void;
  clearLastPatch: () => void;
} {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [lastPatch, setLastPatch] = useState<GraphPatch | null>(null);
  const [fullVersion, setFullVersion] = useState(0);
  const [progress, setProgress] = useState<string | null>('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [layoutEngine, setLayoutEngine] = useState<string | null>(null);
  const readySent = useRef(false);

  const clearLastPatch = useCallback(() => setLastPatch(null), []);

  const handleMessage = useCallback((raw: unknown) => {
    const parsed = safeParseExtensionToWebview(raw);
    if (!parsed.success) {
      setError(`Invalid message from extension: ${parsed.error.message}`);
      return;
    }
    const msg: ExtensionToWebview = parsed.data;
    switch (msg.type) {
      case 'graph:full':
        setSnapshot(msg.payload);
        setLastPatch(null);
        setFullVersion((v) => v + 1);
        setProgress(null);
        setError(null);
        break;
      case 'graph:patch':
        setSnapshot((prev) => {
          if (!prev) {
            return prev;
          }
          return mergePatch(prev, msg.payload);
        });
        setLastPatch(msg.payload);
        setProgress(null);
        break;
      case 'progress':
        setProgress(msg.payload.message || null);
        break;
      case 'error':
        setError(`${msg.payload.scope}: ${msg.payload.message}`);
        setProgress(null);
        break;
      case 'search:results':
        break;
    }
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      handleMessage(event.data);
    };
    window.addEventListener('message', listener);

    if (!readySent.current) {
      readySent.current = true;
      postToExtension({ type: 'ready' });
    }

    return () => window.removeEventListener('message', listener);
  }, [handleMessage]);

  return {
    snapshot,
    lastPatch,
    fullVersion,
    progress,
    error,
    layoutEngine,
    setLayoutEngine,
    clearLastPatch,
  };
}
