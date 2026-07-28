import { useCallback } from 'react';
import { ArchitectureGraph } from './components/ArchitectureGraph';
import {
  postToExtension,
  useExtensionMessages,
} from './hooks/useExtensionMessages';

export function App() {
  const { snapshot, progress, error, layoutEngine, setLayoutEngine } =
    useExtensionMessages();

  const onRefresh = useCallback(() => {
    postToExtension({ type: 'graph:refresh' });
  }, []);

  return (
    <div className="cm-app">
      <header className="cm-toolbar">
        <div className="cm-brand">CodeMap</div>
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
