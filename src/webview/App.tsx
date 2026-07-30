import { useCallback } from 'react';
import { ArchitectureGraph } from './components/ArchitectureGraph';
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
  } = useExtensionMessages();

  const onRefresh = useCallback(() => {
    postToExtension({ type: 'graph:refresh' });
  }, []);

  return (
    <div className="cm-app">
      <header className="cm-toolbar">
        <div className="cm-brand">CodeMap</div>
        <button type="button" className="cm-btn" onClick={onRefresh}>
          Refresh
        </button>
        {layoutEngine ? (
          <span className="cm-meta">layout: {layoutEngine}</span>
        ) : null}
        {progress ? <span className="cm-progress">{progress}</span> : null}
      </header>

      <div className="cm-banner" role="note">
        Progressive explorer — double-click to expand folders, files, and
        functions. Ctrl/Cmd+double-click opens in the editor. Static analysis
        only.
      </div>

      {error ? <div className="cm-error">{error}</div> : null}

      <main className="cm-main">
        {snapshot ? (
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
