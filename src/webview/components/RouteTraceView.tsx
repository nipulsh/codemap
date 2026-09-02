import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RouteTraceDataWire } from '../../../shared/routeTrace';
import {
  filterTraceByDepth,
  projectTraceToSnapshot,
  sortRoutes,
  UNRESOLVED_REASON_LABELS,
} from '../../../shared/routeTrace';
import type { RuntimeTraceSummaryWire } from '../../../shared/runtimeTrace';
import { formatRuntimeTraceSummary, summariesForRoute } from '../../../shared/runtimeTrace';
import type { TraceOverlayWire } from '../../../shared/traceOverlay';
import {
  findOverlayNodeForGraphId,
  OVERLAY_OBSERVATION_LABELS,
  projectOverlaySnapshot,
} from '../../../shared/traceOverlay';
import { ArchitectureGraph } from './ArchitectureGraph';
import {
  postToExtension,
  type RouteTraceDisplayMode,
} from '../hooks/useExtensionMessages';
import { layoutTraceByDepth } from '../routeTrace/layoutTraceByDepth';
import { DEFAULT_CALL_CHAIN_MAX_DEPTH } from '../../../shared/routeTrace';

export interface RouteTraceState {
  selectedRouteId?: string;
  maxVisibleDepth: number;
  viewMode: 'architecture' | 'route-trace';
  methodFilter: string;
  pathFilter: string;
  traceDisplayMode: RouteTraceDisplayMode;
  selectedRuntimeTraceId?: string;
}

interface Props {
  data: RouteTraceDataWire;
  workspaceRoot?: string;
  runtimeTraces: RuntimeTraceSummaryWire[];
  runtimeOverlay: TraceOverlayWire | null;
  runtimeOverlayError: string | null;
  onBackToArchitecture: () => void;
  onRefreshRuntimeTraces: () => void;
  onSelectRuntimeTrace: (routeId: string, traceId: string) => void;
  onClearRuntimeOverlay: () => void;
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export function RouteTraceView({
  data,
  workspaceRoot,
  runtimeTraces,
  runtimeOverlay,
  runtimeOverlayError,
  onBackToArchitecture,
  onRefreshRuntimeTraces,
  onSelectRuntimeTrace,
  onClearRuntimeOverlay,
}: Props) {
  const sortedRoutes = useMemo(() => sortRoutes(data.routes), [data.routes]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | undefined>(
    sortedRoutes[0]?.id,
  );
  const [maxVisibleDepth, setMaxVisibleDepth] = useState(
    DEFAULT_CALL_CHAIN_MAX_DEPTH,
  );
  const [methodFilter, setMethodFilter] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [traceDisplayMode, setTraceDisplayMode] =
    useState<RouteTraceDisplayMode>('static');
  const [selectedRuntimeTraceId, setSelectedRuntimeTraceId] = useState<
    string | undefined
  >();
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string>();

  const filteredRoutes = useMemo(() => {
    const mf = methodFilter.trim().toUpperCase();
    const pf = pathFilter.trim().toLowerCase();
    return sortedRoutes.filter((r) => {
      if (mf && r.method !== mf) {
        return false;
      }
      if (pf && !r.path.toLowerCase().includes(pf)) {
        return false;
      }
      return true;
    });
  }, [sortedRoutes, methodFilter, pathFilter]);

  const selectedTrace = useMemo(() => {
    if (!selectedRouteId) {
      return undefined;
    }
    return data.traces.find((t) => t.routeId === selectedRouteId);
  }, [data.traces, selectedRouteId]);

  const routeRuntimeTraces = useMemo(() => {
    if (!selectedRouteId) {
      return [];
    }
    return summariesForRoute(runtimeTraces, selectedRouteId);
  }, [runtimeTraces, selectedRouteId]);

  useEffect(() => {
    if (traceDisplayMode !== 'runtime-overlay' || !selectedRouteId) {
      return;
    }
    const traces = summariesForRoute(runtimeTraces, selectedRouteId);
    if (traces.length === 0) {
      setSelectedRuntimeTraceId(undefined);
      onClearRuntimeOverlay();
      return;
    }
    setSelectedRuntimeTraceId((prev) => {
      if (prev && traces.some((t) => t.traceId === prev)) {
        return prev;
      }
      return traces[0]!.traceId;
    });
  }, [
    traceDisplayMode,
    selectedRouteId,
    runtimeTraces,
    onClearRuntimeOverlay,
  ]);

  useEffect(() => {
    if (
      traceDisplayMode !== 'runtime-overlay' ||
      !selectedRouteId ||
      !selectedRuntimeTraceId
    ) {
      return;
    }
    onSelectRuntimeTrace(selectedRouteId, selectedRuntimeTraceId);
  }, [
    traceDisplayMode,
    selectedRouteId,
    selectedRuntimeTraceId,
    onSelectRuntimeTrace,
  ]);

  useEffect(() => {
    setSelectedGraphNodeId(undefined);
  }, [selectedRouteId, traceDisplayMode, selectedRuntimeTraceId]);

  const staticProjected = useMemo(() => {
    if (!selectedTrace) {
      return null;
    }
    const filtered = filterTraceByDepth(selectedTrace, maxVisibleDepth);
    return projectTraceToSnapshot(filtered, workspaceRoot);
  }, [selectedTrace, maxVisibleDepth, workspaceRoot]);

  const projected = useMemo(() => {
    if (!staticProjected) {
      return null;
    }
    if (traceDisplayMode !== 'runtime-overlay' || !runtimeOverlay) {
      return staticProjected;
    }
    try {
      return projectOverlaySnapshot(staticProjected, runtimeOverlay, workspaceRoot);
    } catch {
      return staticProjected;
    }
  }, [
    staticProjected,
    traceDisplayMode,
    runtimeOverlay,
    workspaceRoot,
  ]);

  const traceLayoutKey = useMemo(() => {
    if (!projected) {
      return 'empty';
    }
    return `${selectedRouteId}:${maxVisibleDepth}:${traceDisplayMode}:${selectedRuntimeTraceId ?? 'none'}:${projected.nodes.length}`;
  }, [
    projected,
    selectedRouteId,
    maxVisibleDepth,
    traceDisplayMode,
    selectedRuntimeTraceId,
  ]);

  const openSource = useCallback((filePath?: string, line?: number) => {
    if (!filePath) {
      return;
    }
    postToExtension({
      type: 'node:open',
      payload: { filePath, line },
    });
  }, []);

  const selectedRoute = sortedRoutes.find((r) => r.id === selectedRouteId);
  const detailOverlayNode =
    runtimeOverlay && selectedGraphNodeId
      ? findOverlayNodeForGraphId(runtimeOverlay, selectedGraphNodeId)
      : undefined;

  const handleRuntimeTraceChange = useCallback(
    (traceId: string) => {
      if (!selectedRouteId) {
        return;
      }
      setSelectedRuntimeTraceId(traceId);
      onSelectRuntimeTrace(selectedRouteId, traceId);
    },
    [selectedRouteId, onSelectRuntimeTrace],
  );

  const handleDisplayModeChange = useCallback(
    (mode: RouteTraceDisplayMode) => {
      setTraceDisplayMode(mode);
      if (mode === 'static') {
        onClearRuntimeOverlay();
      }
    },
    [onClearRuntimeOverlay],
  );

  return (
    <div className="cm-route-trace">
      <aside className="cm-route-sidebar">
        <div className="cm-route-sidebar-header">
          <h2 className="cm-route-title">API Routes</h2>
          <button type="button" className="cm-btn cm-btn-secondary" onClick={onBackToArchitecture}>
            ← Architecture
          </button>
        </div>

        <div className="cm-route-filters">
          <label className="cm-route-filter">
            Method
            <input
              type="text"
              placeholder="GET"
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
            />
          </label>
          <label className="cm-route-filter">
            Path
            <input
              type="text"
              placeholder="/api/..."
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
            />
          </label>
        </div>

        <ul className="cm-route-list" role="listbox" aria-label="API routes">
          {filteredRoutes.map((route) => (
            <li key={route.id}>
              <button
                type="button"
                role="option"
                aria-selected={route.id === selectedRouteId}
                className={`cm-route-item ${route.id === selectedRouteId ? 'cm-route-item-active' : ''}`}
                onClick={() => {
                  setSelectedRouteId(route.id);
                  setSelectedGraphNodeId(undefined);
                }}
              >
                <span className="cm-route-method">{route.method}</span>
                <span className="cm-route-path">{route.path}</span>
              </button>
            </li>
          ))}
          {filteredRoutes.length === 0 ? (
            <li className="cm-route-empty">No routes match filters.</li>
          ) : null}
        </ul>
      </aside>

      <section className="cm-route-detail">
        <div className="cm-trace-mode-toggle" role="tablist" aria-label="Trace display mode">
          <button
            type="button"
            role="tab"
            aria-selected={traceDisplayMode === 'static'}
            className={`cm-btn ${traceDisplayMode === 'static' ? 'cm-btn-active' : 'cm-btn-secondary'}`}
            onClick={() => handleDisplayModeChange('static')}
          >
            Static
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traceDisplayMode === 'runtime-overlay'}
            className={`cm-btn ${traceDisplayMode === 'runtime-overlay' ? 'cm-btn-active' : 'cm-btn-secondary'}`}
            onClick={() => handleDisplayModeChange('runtime-overlay')}
          >
            Runtime Overlay
          </button>
        </div>

        {traceDisplayMode === 'static' ? (
          <div className="cm-static-banner" role="note">
            <strong>STATIC ANALYSIS</strong>
            <span>
              This route trace is inferred from source code. It does not represent
              confirmed runtime execution order.
            </span>
          </div>
        ) : (
          <div className="cm-runtime-banner" role="note">
            <strong>RUNTIME OVERLAY</strong>
            <span>
              Observed execution is highlighted. Unobserved nodes and edges are
              statically inferred but were not observed during this trace.
            </span>
          </div>
        )}

        {traceDisplayMode === 'runtime-overlay' ? (
          <div className="cm-runtime-controls">
            <div className="cm-runtime-trace-picker">
              <label>
                Runtime Trace
                <select
                  value={selectedRuntimeTraceId ?? ''}
                  onChange={(e) => handleRuntimeTraceChange(e.target.value)}
                  disabled={routeRuntimeTraces.length === 0}
                >
                  {routeRuntimeTraces.length === 0 ? (
                    <option value="">No traces</option>
                  ) : (
                    routeRuntimeTraces.map((trace) => (
                      <option key={trace.traceId} value={trace.traceId}>
                        {formatRuntimeTraceSummary(trace)}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                className="cm-btn cm-btn-secondary"
                onClick={onRefreshRuntimeTraces}
              >
                Refresh Runtime Trace
              </button>
            </div>
            {routeRuntimeTraces.length === 0 ? (
              <p className="cm-runtime-empty" role="status">
                No runtime traces available for this route. Run the instrumented
                application to capture one.
              </p>
            ) : null}
            {runtimeOverlayError ? (
              <p className="cm-runtime-overlay-error" role="alert">
                {runtimeOverlayError}. Showing static trace only.
              </p>
            ) : null}
          </div>
        ) : null}

        {selectedRoute && selectedTrace ? (
          <>
            <div className="cm-route-meta">
              <h3>
                {selectedRoute.method} {selectedRoute.path}
              </h3>
              <dl className="cm-route-meta-grid">
                <div>
                  <dt>Framework</dt>
                  <dd>{selectedRoute.framework}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <button
                      type="button"
                      className="cm-link-btn"
                      onClick={() =>
                        openSource(selectedRoute.sourceFile, selectedRoute.line)
                      }
                    >
                      {basename(selectedRoute.sourceFile)}:{selectedRoute.line}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Handler</dt>
                  <dd>
                    {selectedRoute.handlerSymbol && selectedRoute.handlerResolved ? (
                      <button
                        type="button"
                        className="cm-link-btn"
                        onClick={() =>
                          openSource(
                            selectedTrace.entryHandler?.filePath,
                            selectedTrace.entryHandler?.line,
                          )
                        }
                      >
                        {selectedRoute.handlerSymbol}
                      </button>
                    ) : (
                      'unresolved'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{selectedRoute.confidence}</dd>
                </div>
              </dl>
            </div>

            <div className="cm-trace-controls">
              <label className="cm-trace-depth">
                Trace Depth:{' '}
                <input
                  type="range"
                  min={0}
                  max={selectedTrace.maxDepth}
                  value={maxVisibleDepth}
                  onChange={(e) => setMaxVisibleDepth(Number(e.target.value))}
                />
                <span className="cm-trace-depth-value">{maxVisibleDepth}</span>
              </label>
              {selectedTrace.truncated ? (
                <p className="cm-trace-truncated" role="status">
                  Trace truncated at configured maximum depth ({selectedTrace.maxDepth}).
                </p>
              ) : null}
            </div>

            {selectedTrace.unresolved.length > 0 ? (
              <div className="cm-unresolved-panel">
                <h4>Unresolved calls</h4>
                <ul>
                  {selectedTrace.unresolved.map((u, i) => (
                    <li key={`${u.fromNodeId}:${u.displayName}:${i}`}>
                      <span className="cm-unresolved-icon" aria-hidden>
                        ⚠
                      </span>
                      {UNRESOLVED_REASON_LABELS[u.reason]}: {u.displayName}
                      {u.line !== undefined ? ` (line ${u.line})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {detailOverlayNode && traceDisplayMode === 'runtime-overlay' ? (
              <div className="cm-overlay-detail">
                <h4>Runtime detail</h4>
                <dl>
                  <div>
                    <dt>Observation</dt>
                    <dd>{OVERLAY_OBSERVATION_LABELS[detailOverlayNode.observation]}</dd>
                  </div>
                  {detailOverlayNode.metrics ? (
                    <>
                      <div>
                        <dt>Invocations</dt>
                        <dd>{detailOverlayNode.metrics.invocationCount}</dd>
                      </div>
                      {detailOverlayNode.metrics.totalDurationMs !== undefined ? (
                        <div>
                          <dt>Total</dt>
                          <dd>{detailOverlayNode.metrics.totalDurationMs} ms</dd>
                        </div>
                      ) : null}
                      {detailOverlayNode.metrics.maxDurationMs !== undefined ? (
                        <div>
                          <dt>Max</dt>
                          <dd>{detailOverlayNode.metrics.maxDurationMs} ms</dd>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {detailOverlayNode.error ? (
                    <div>
                      <dt>Error</dt>
                      <dd>
                        ✕ {detailOverlayNode.error.name ?? 'Error'}:{' '}
                        {detailOverlayNode.error.message}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}

            {projected ? (
              <div className="cm-trace-graph">
                <ArchitectureGraph
                  snapshot={projected}
                  lastPatch={null}
                  fullVersion={traceLayoutKey.split('').reduce((a, c) => a + c.charCodeAt(0), 0)}
                  traceMode
                  overlayMode={traceDisplayMode === 'runtime-overlay'}
                  traceLayout={layoutTraceByDepth(projected)}
                  onNodeSelect={setSelectedGraphNodeId}
                />
              </div>
            ) : null}
          </>
        ) : (
          <div className="cm-empty">Select a route to view its static trace.</div>
        )}
      </section>
    </div>
  );
}
