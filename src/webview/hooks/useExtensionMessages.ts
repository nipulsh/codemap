import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionToWebview, WebviewToExtension } from '../../../shared/messages';
import { safeParseExtensionToWebview } from '../../../shared/messages';
import type { RouteTraceDataWire, ViewMode } from '../../../shared/routeTrace';
import type { RuntimeTraceSummaryWire } from '../../../shared/runtimeTrace';
import type { TraceOverlayWire } from '../../../shared/traceOverlay';
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

export type RouteTraceDisplayMode = 'static' | 'runtime-overlay';

export function useExtensionMessages(): {
  snapshot: GraphSnapshot | null;
  lastPatch: GraphPatch | null;
  fullVersion: number;
  progress: string | null;
  error: string | null;
  layoutEngine: string | null;
  setLayoutEngine: (engine: string | null) => void;
  clearLastPatch: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  routeTraceData: RouteTraceDataWire | null;
  routeTraceLoading: boolean;
  requestRouteTraces: () => void;
  runtimeTraces: RuntimeTraceSummaryWire[];
  runtimeOverlay: TraceOverlayWire | null;
  runtimeOverlayError: string | null;
  refreshRuntimeTraces: () => void;
  selectRuntimeTrace: (routeId: string, traceId: string) => void;
  clearRuntimeOverlay: () => void;
} {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [lastPatch, setLastPatch] = useState<GraphPatch | null>(null);
  const [fullVersion, setFullVersion] = useState(0);
  const [progress, setProgress] = useState<string | null>('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [layoutEngine, setLayoutEngine] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('architecture');
  const [routeTraceData, setRouteTraceData] = useState<RouteTraceDataWire | null>(null);
  const [routeTraceLoading, setRouteTraceLoading] = useState(false);
  const [runtimeTraces, setRuntimeTraces] = useState<RuntimeTraceSummaryWire[]>([]);
  const [runtimeOverlay, setRuntimeOverlay] = useState<TraceOverlayWire | null>(null);
  const [runtimeOverlayError, setRuntimeOverlayError] = useState<string | null>(null);
  const readySent = useRef(false);

  const clearLastPatch = useCallback(() => setLastPatch(null), []);

  const requestRouteTraces = useCallback(() => {
    setRouteTraceLoading(true);
    postToExtension({ type: 'routeTrace:request' });
  }, []);

  const refreshRuntimeTraces = useCallback(() => {
    postToExtension({ type: 'runtimeTrace:refresh' });
  }, []);

  const selectRuntimeTrace = useCallback((routeId: string, traceId: string) => {
    setRuntimeOverlayError(null);
    postToExtension({
      type: 'runtimeTrace:select',
      payload: { routeId, traceId },
    });
  }, []);

  const clearRuntimeOverlay = useCallback(() => {
    setRuntimeOverlay(null);
    setRuntimeOverlayError(null);
  }, []);

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
        if (msg.payload.scope === 'runtime-overlay') {
          setRuntimeOverlayError(`${msg.payload.scope}: ${msg.payload.message}`);
        } else {
          setError(`${msg.payload.scope}: ${msg.payload.message}`);
        }
        setProgress(null);
        break;
      case 'search:results':
        break;
      case 'routeTrace:data':
        setRouteTraceData(msg.payload);
        setRuntimeTraces(msg.payload.runtimeTraces ?? []);
        setRouteTraceLoading(false);
        setViewMode('route-trace');
        setError(null);
        break;
      case 'runtimeTrace:list':
        setRuntimeTraces(msg.payload.runtimeTraces);
        break;
      case 'runtimeTrace:overlay':
        setRuntimeOverlay(msg.payload);
        setRuntimeOverlayError(null);
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
    viewMode,
    setViewMode,
    routeTraceData,
    routeTraceLoading,
    requestRouteTraces,
    runtimeTraces,
    runtimeOverlay,
    runtimeOverlayError,
    refreshRuntimeTraces,
    selectRuntimeTrace,
    clearRuntimeOverlay,
  };
}