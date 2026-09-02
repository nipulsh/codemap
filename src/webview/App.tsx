import { useCallback } from 'react';
import { ArchitectureGraph } from './components/ArchitectureGraph';
import { RouteTraceView } from './components/RouteTraceView';
import {
  postToExtension,
  useExtensionMessages,
} from './hooks/useExtensionMessages';

export function App() {
  const {
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
  } = useExtensionMessages();

  const onRefresh = useCallback(() => {
    postToExtension({ type: 'graph:refresh' });
  }, []);

  const onOpenRouteTrace = useCallback(() => {
    requestRouteTraces();
  }, [requestRouteTraces]);

  const onBackToArchitecture = useCallback(() => {
    setViewMode('architecture');
    postToExtension({
      type: 'viewMode:set',
      payload: { mode: 'architecture' },
    });
  }, [setViewMode]);

  return (
    <div className="cm-app">
      <header className="cm-toolbar">
        <div className="cm-brand">CodeMap</div>
        <button type="button" className="cm-btn" onClick={onRefresh}>
          Refresh
        </button>
        <button
          type="button"
          className={`cm-btn ${viewMode === 'route-trace' ? 'cm-btn-active' : 'cm-btn-secondary'}`}
          onClick={onOpenRouteTrace}
          disabled={routeTraceLoading}
        >
          {routeTraceLoading ? 'Loading routes…' : 'Route Trace'}
        </button>
        {layoutEngine ? (
          <span className="cm-meta">layout: {layoutEngine}</span>
        ) : null}
        {progress ? <span className="cm-progress">{progress}</span> : null}
      </header>

      {viewMode === 'architecture' ? (
        <div className="cm-banner" role="note">
          Progressive explorer — double-click to expand folders, files, and
          functions. Ctrl/Cmd+double-click opens in the editor. Static analysis
          only.
        </div>
      ) : null}

      {error ? <div className="cm-error">{error}</div> : null}

      <main className="cm-main">
        {viewMode === 'route-trace' && routeTraceData ? (
          <RouteTraceView
            data={routeTraceData}
            workspaceRoot={snapshot?.workspaceRoot}
            runtimeTraces={runtimeTraces}
            runtimeOverlay={runtimeOverlay}
            runtimeOverlayError={runtimeOverlayError}
            onBackToArchitecture={onBackToArchitecture}
            onRefreshRuntimeTraces={refreshRuntimeTraces}
            onSelectRuntimeTrace={selectRuntimeTrace}
            onClearRuntimeOverlay={clearRuntimeOverlay}
          />
        ) : snapshot ? (
          <ArchitectureGraph
            snapshot={snapshot}
            lastPatch={lastPatch}
            fullVersion={fullVersion}
            onLayoutEngine={setLayoutEngine}
            clearLastPatch={clearLastPatch}
          />
        ) : (
          <div className="cm-empty">
            {progress ?? 'Waiting for workspace…'}
          </div>
        )}
      </main>
    </div>
  );
}
