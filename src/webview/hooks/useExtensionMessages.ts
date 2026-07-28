import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionToWebview, WebviewToExtension } from '../../../shared/messages';
import { safeParseExtensionToWebview } from '../../../shared/messages';
import type { GraphSnapshot } from '../../../shared/graph';

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

export function useExtensionMessages(): {
  snapshot: GraphSnapshot | null;
  progress: string | null;
  error: string | null;
  layoutEngine: string | null;
  setLayoutEngine: (engine: string | null) => void;
} {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [progress, setProgress] = useState<string | null>('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [layoutEngine, setLayoutEngine] = useState<string | null>(null);
  const readySent = useRef(false);

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
        setProgress(null);
        setError(null);
        break;
      case 'graph:patch':
        // Phase 2
        break;
      case 'progress':
        setProgress(msg.payload.message);
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

  return { snapshot, progress, error, layoutEngine, setLayoutEngine };
}
