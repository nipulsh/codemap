import { useCallback, useState } from 'react';
import { ArchitectureGraph } from './components/ArchitectureGraph';
import { RouteTraceView } from './components/RouteTraceView';
import {
  postToExtension,
  useExtensionMessages,
} from './hooks/useExtensionMessages';
import { NODE_SIZES, type NodeSize } from './layout/nodeSizes';
import { EDGE_FILTER_OPTIONS, type EdgeFilter } from './edgeFilter';

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

  const [nodeSize, setNodeSize] = useState<NodeSize>('medium');
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

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
        {viewMode === 'architecture' ? (
          <>
            <div className="cm-size-group" role="group" aria-label="Node size">
              {NODE_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  className={
                    nodeSize === size ? 'cm-btn cm-btn-active' : 'cm-btn cm-btn-secondary'
                  }
                  onClick={() => setNodeSize(size)}
                >
                  {size.charAt(0).toUpperCase() + size.slice(1)}
                </button>
              ))}
            </div>
            <label className="cm-filter-label">
              Filter
              <select
                className="cm-select"
                value={edgeFilter}
                onChange={(e) => setEdgeFilter(e.target.value as EdgeFilter)}
              >
                {EDGE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="cm-search-label">
              Search
              <input
                type="search"
                className="cm-search-input"
                value={searchQuery}
                placeholder="Name or path…"
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="cm-search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery('')}
                >
                  ×
                </button>
              ) : null}
            </label>
          </>
        ) : null}
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
            nodeSize={nodeSize}
            edgeFilter={edgeFilter}
            searchQuery={searchQuery}
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
