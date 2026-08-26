import { useCallback, useState } from 'react';
import { ArchitectureGraph } from './components/ArchitectureGraph';
import {
  postToExtension,
  useExtensionMessages,
} from './hooks/useExtensionMessages';
import { NODE_SIZES, type NodeSize } from './layout/nodeSizes';
import { EDGE_FILTER_OPTIONS, type EdgeFilter } from './edgeFilter';

export function App() {
  const { snapshot, progress, error, layoutEngine, setLayoutEngine } =
    useExtensionMessages();
  const [nodeSize, setNodeSize] = useState<NodeSize>('medium');
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const onRefresh = useCallback(() => {
    postToExtension({ type: 'graph:refresh' });
  }, []);

  return (
    <div className="cm-app">
      <header className="cm-toolbar">
        <div className="cm-brand">CodeMap</div>
        <div className="cm-size-group" role="group" aria-label="Node size">
          {NODE_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={
                nodeSize === size ? 'cm-btn cm-btn-active' : 'cm-btn'
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
        <button type="button" className="cm-btn" onClick={onRefresh}>
          Refresh Graph
        </button>
        {layoutEngine ? (
          <span className="cm-meta">layout: {layoutEngine}</span>
        ) : null}
        {progress ? <span className="cm-progress">{progress}</span> : null}
      </header>

      <div className="cm-banner" role="note">
        Static import/export graph only. Dynamic dispatch and runtime calls are
        not shown.
      </div>

      {error ? <div className="cm-error">{error}</div> : null}

      <main className="cm-main">
        {snapshot ? (
          <ArchitectureGraph
            snapshot={snapshot}
            nodeSize={nodeSize}
            edgeFilter={edgeFilter}
            searchQuery={searchQuery}
            onLayoutEngine={setLayoutEngine}
          />
        ) : (
          <div className="cm-empty">
            {progress ?? 'Waiting for graph…'}
          </div>
        )}
      </main>
    </div>
  );
}
