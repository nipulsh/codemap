# 12 — Function Reference

Catalog of important exported functions and class methods. Line numbers refer to the current source and may shift slightly with edits.

For stubs with no exports of value, see the [Stubs](#stubs--reserved) section at the end.

---

## Extension

### `activate`

| | |
|--|--|
| **File** | [`src/extension/activate.ts`](../src/extension/activate.ts) ~L4 |
| **Purpose** | Register CodeMap commands with VS Code |
| **Parameters** | `context: vscode.ExtensionContext` |
| **Returns** | `void` |
| **Called by** | VS Code Extension Host |
| **Calls** | `registerCommand`, `ArchitecturePanel.createOrShow`, `bootstrap`, `refresh` |
| **Side effects** | Adds disposables to `context.subscriptions` |

**Pseudo-code**

```
register openArchitecture → createOrShow + bootstrap
register refreshGraph → refresh OR createOrShow + bootstrap
```

---

### `deactivate`

| | |
|--|--|
| **File** | [`src/extension/activate.ts`](../src/extension/activate.ts) ~L24 |
| **Purpose** | Tear down the panel when the extension unloads |
| **Calls** | `ArchitecturePanel.current?.dispose()` |

---

### `ArchitecturePanel.createOrShow`

| | |
|--|--|
| **File** | [`src/extension/ArchitecturePanel.ts`](../src/extension/ArchitecturePanel.ts) ~L67 |
| **Purpose** | Reveal existing panel or create a new singleton |
| **Parameters** | `extensionUri: vscode.Uri` |
| **Returns** | `ArchitecturePanel` |
| **Called by** | `activate` command handlers |
| **Calls** | `createWebviewPanel`, constructor |
| **Side effects** | Sets `ArchitecturePanel.current` |

---

### `ArchitecturePanel.bootstrap`

| | |
|--|--|
| **File** | ~L123 |
| **Purpose** | Load root graph for the first workspace folder |
| **Returns** | `Promise<void>` |
| **Called by** | open command, `ready` message |
| **Calls** | `explorer.bootstrap` |
| **Side effects** | Sets `busy`; may post `error` |

**Pseudo-code**

```
if busy: return
busy = true
if no workspaceFolders: post error; return
await explorer.bootstrap(folders[0].fsPath)
finally busy = false
```

---

### `ArchitecturePanel.refresh`

| | |
|--|--|
| **File** | ~L92 |
| **Purpose** | Rebuild graph and re-expand prior nodes |
| **Calls** | `explorer.refresh` |

---

### `ArchitecturePanel.dispose`

| | |
|--|--|
| **File** | ~L282 |
| **Purpose** | Release explorer, worker, panel, disposables |
| **Side effects** | Clears `current`; terminates worker |

---

### `MessageBus.post`

| | |
|--|--|
| **File** | [`src/extension/messageBus.ts`](../src/extension/messageBus.ts) ~L15 |
| **Purpose** | Validate and send a message to the webview |
| **Parameters** | `message: ExtensionToWebview` |
| **Calls** | `parseExtensionToWebview`, `webview.postMessage` |
| **Side effects** | Throws if message fails Zod parse |

---

### `MessageBus.onMessage`

| | |
|--|--|
| **File** | ~L20 |
| **Purpose** | Subscribe to validated webview messages |
| **Parameters** | `handler: (WebviewToExtension) => void` |
| **Returns** | `vscode.Disposable` |
| **Side effects** | On invalid message, posts `error` with scope `message-bus` |

---

## Explorer

### `ExplorerService.bootstrap`

| | |
|--|--|
| **File** | [`src/explorer/ExplorerService.ts`](../src/explorer/ExplorerService.ts) ~L66 |
| **Purpose** | Clear state; list workspace root; emit `graph:full` |
| **Parameters** | `workspaceRoot: string` |
| **Calls** | `clearState`, `listDirectory`, `workspaceLabel`, `makeNode`, `makeEdge`, `emit` |
| **Side effects** | Fills maps, FolderCache; creates BackgroundPrefetch |

---

### `ExplorerService.refresh`

| | |
|--|--|
| **File** | ~L139 |
| **Purpose** | Remember expansions; clear caches; bootstrap; re-expand |
| **Calls** | `bootstrap`, `expandFolder`, `expandFile`, `expandFunction` |

---

### `ExplorerService.expandFolder`

| | |
|--|--|
| **File** | ~L167 |
| **Purpose** | Add immediate child folders/files under a directory |
| **Parameters** | `path: string` |
| **Calls** | `listDirectory` or FolderCache; `makeNode`/`makeEdge`; `patch`; `prefetch.enqueueFiles` |
| **Side effects** | Marks folder expanded; may prefetch parses |

---

### `ExplorerService.collapseFolder`

| | |
|--|--|
| **File** | ~L251 |
| **Purpose** | Remove descendant nodes under a folder (not workspace root) |
| **Calls** | `collectDescendants`, `patch` |

---

### `ExplorerService.expandFile`

| | |
|--|--|
| **File** | ~L291 |
| **Purpose** | Parse a source file; add symbols + import edges; rewire calls |
| **Parameters** | `path: string` |
| **Calls** | `ensureParsed`, `makeNode`/`makeEdge`, `rewireCallsToFile`, `patch` |
| **Side effects** | Progress messages; FileCache fill; expandedFiles |

**Complexity:** Dominated by worker parse + O(symbols + deps + existing call edges) for rewire.

---

### `ExplorerService.collapseFile`

| | |
|--|--|
| **File** | ~L406 |
| **Purpose** | Remove symbol children and import/contains edges from a file |
| **Calls** | `collectDescendants`, `patch` |

---

### `ExplorerService.expandFunction`

| | |
|--|--|
| **File** | ~L442 |
| **Purpose** | Resolve callees and add `calls` edges |
| **Parameters** | `nodeId: string` |
| **Calls** | FunctionCache or `pool.resolveCalls`; `makeEdge`; `patch` |

---

### `ExplorerService.collapseFunction`

| | |
|--|--|
| **File** | ~L548 |
| **Purpose** | Remove outbound `calls` edges from a symbol node |

---

### `ExplorerService.onFileChanged` / `onDirectoryChanged`

| | |
|--|--|
| **File** | ~L564 / ~L576 |
| **Purpose** | Invalidate caches; re-expand if currently expanded |
| **Called by** | `ArchitecturePanel.handleFsEvent` |

---

### `ExplorerService.dispose`

| | |
|--|--|
| **File** | ~L595 |
| **Purpose** | Cancel prefetch; clear all explorer state |

---

### `BackgroundPrefetch.enqueueFiles`

| | |
|--|--|
| **File** | [`src/explorer/prefetch.ts`](../src/explorer/prefetch.ts) ~L25 |
| **Purpose** | Queue low-priority parses into FileCache |
| **Parameters** | `absolutePaths: string[]` |
| **Calls** | `pool.parseFiles({ priority: 'low' })`, `fileCache.set` |
| **Side effects** | Does **not** emit graph patches |

---

### `BackgroundPrefetch.cancel`

| | |
|--|--|
| **File** | ~L100 |
| **Purpose** | Stop further prefetch batches |

---

## Scanner

### `listDirectory`

| | |
|--|--|
| **File** | [`src/scanner/listDirectory.ts`](../src/scanner/listDirectory.ts) ~L33 |
| **Purpose** | Non-recursive listing of folders, files, tsconfigs |
| **Parameters** | `dirPath`, `workspaceRoot` |
| **Returns** | `DirectoryListing` |
| **Called by** | `ExplorerService.bootstrap`, `expandFolder` |
| **Calls** | `readdirSync`, ignore helpers, `contentHash`, `fileMtimeMs` |

**Pseudo-code**

```
realpath dir
for each entry:
  if dir and not ignored → folders
  if tsconfig → tsconfigs
  if source and not ignored → files
  if explorer-visible config/doc → files
sort and return
```

---

### `findNearestTsConfig`

| | |
|--|--|
| **File** | ~L148 |
| **Purpose** | Walk parents for `tsconfig.json` |
| **Returns** | `TsConfigInfo | undefined` |
| **Called by** | `ExplorerService.ensureTsconfigFor` |

---

### `workspaceLabel`

| | |
|--|--|
| **File** | ~L173 |
| **Purpose** | Basename of workspace root for the Workspace node label |

---

### `scanWorkspace`

| | |
|--|--|
| **File** | [`src/scanner/workspaceScanner.ts`](../src/scanner/workspaceScanner.ts) ~L85 |
| **Purpose** | Recursive collect all source files + tsconfigs |
| **Returns** | `ScanResult` |
| **Called by** | `tests/helpers.ts` (not live panel) |
| **Calls** | internal `walkDirectory` |

---

### `findTsConfigForFile`

| | |
|--|--|
| **File** | ~L115 |
| **Purpose** | Pick longest covering `baseDir` tsconfig for a file |
| **Used by** | Full-scan / test helpers |

---

### `shouldIgnoreDirectory` / `shouldIgnoreFile` / `isSourceFile`

| | |
|--|--|
| **File** | [`src/scanner/ignore.ts`](../src/scanner/ignore.ts) |
| **Purpose** | Hardcoded ignore + extension checks |
| **Called by** | scanners, explorer, panel, prefetch |

---

## Parser / workers

### `WorkerPool.parseFiles`

| | |
|--|--|
| **File** | [`src/parser/workerPool.ts`](../src/parser/workerPool.ts) ~L157 |
| **Purpose** | Enqueue multi-file parse (supports priority) |
| **Returns** | `Promise<FileParseResult[]>` |
| **Called by** | BackgroundPrefetch |

---

### `WorkerPool.parseFile`

| | |
|--|--|
| **File** | ~L178 |
| **Purpose** | High-priority single-file parse |
| **Returns** | `Promise<FileParseResult>` |
| **Called by** | `ExplorerService.ensureParsed` |

---

### `WorkerPool.resolveCalls`

| | |
|--|--|
| **File** | ~L211 |
| **Purpose** | High-priority callee resolution |
| **Returns** | `Promise<ResolveCallsResult>` |
| **Called by** | `ExplorerService.expandFunction` |

---

### `WorkerPool.dispose`

| | |
|--|--|
| **File** | ~L234 |
| **Purpose** | Clear queue; terminate worker |

---

### `parseFiles` / `parseFile` / `resolveCalls` (library)

| | |
|--|--|
| **File** | [`src/parser/extractImports.ts`](../src/parser/extractImports.ts) ~L343 / ~L447 / ~L469 |
| **Purpose** | Actual AST work (runs inside worker) |
| **Called by** | `parseWorker`; optionally tests |
| **Calls** | TypeScript APIs, `extractSymbols`, `resolveFunctionCallees` |
| **Side effects** | Reads filesystem for source/tsconfig |

**Algorithm (parseFiles):** load projects → for each file create SourceFile → extract imports/exports/symbols → barrel hop → collect dependencyPaths / dynamicImportPaths → per-file try/catch.

---

### `extractSymbols`

| | |
|--|--|
| **File** | [`src/parser/extractSymbols.ts`](../src/parser/extractSymbols.ts) ~L50 |
| **Purpose** | Collect top-level symbols from a SourceFile |
| **Returns** | `SymbolInfo[]` |
| **Called by** | extractImports pipeline |

---

### `resolveFunctionCallees`

| | |
|--|--|
| **File** | ~L237 |
| **Purpose** | Find direct callees inside a named function span |
| **Returns** | `CalleeRef[]` |
| **Called by** | `resolveCalls` |

---

## Graph

### ID helpers

| Function | File | Returns |
|----------|------|---------|
| `workspaceNodeId` | `incremental.ts` ~L11 | `workspace:…` |
| `folderNodeId` | ~L15 | `folder:…` |
| `fileNodeId` | ~L19 | `file:…` |
| `symbolNodeId` | ~L23 | `symbol:…:Kind:name` |
| `edgeId` | ~L31 | `kind:source->target` |

**Called by:** ExplorerService throughout.

---

### `makeNode` / `makeEdge`

| | |
|--|--|
| **File** | `incremental.ts` ~L35 / ~L51 |
| **Purpose** | Construct GraphNode / GraphEdge with stable ids |

---

### `emptyPatch` / `mergePatches` / `applyPatchToMaps`

| | |
|--|--|
| **File** | ~L66 / ~L75 / ~L86 |
| **Purpose** | Patch utilities; `applyPatchToMaps` mutates explorer Maps |

---

### `rewireFileStubToSymbol`

| | |
|--|--|
| **File** | ~L132 |
| **Purpose** | Utility to retarget call edges from file stub → symbol |
| **Note** | Explorer also has private `rewireCallsToFile` used in practice |

---

### `applyGraphPatch`

| | |
|--|--|
| **File** | [`shared/graph.ts`](../shared/graph.ts) ~L81 (re-exported from incremental) |
| **Purpose** | Immutable patch apply for webview (+ shared) |
| **Called by** | `useExtensionMessages`, tests |

---

### `generateGraph`

| | |
|--|--|
| **File** | [`src/graph/generator.ts`](../src/graph/generator.ts) |
| **Purpose** | Build full GraphSnapshot from `IndexedFile[]` |
| **Called by** | tests helpers |
| **Calls** | `detectCycles`, folder chain helpers |

---

### `detectCycles`

| | |
|--|--|
| **File** | `generator.ts` ~L22 |
| **Purpose** | DFS coloring on import/dynamicImport edges; mark cycle metadata |
| **Complexity** | O(N + E) on file dependency subgraph |

---

## Cache

### `FolderCache` methods

`get`, `set`, `invalidate`, `clear`, `has` — [`folderCache.ts`](../src/cache/folderCache.ts)

### `FileCache` methods

`get`, `getAsync`, `set`, `setAsync`, `invalidate`, `clear`, `has`, **`getIfFresh(path, contentHash)`** — [`fileCache.ts`](../src/cache/fileCache.ts)

Backed by `FileSystemDiskCache` for parse persistence across restarts.

### `FunctionCache` methods

`get`, `set`, `invalidate`, `invalidateFile`, `clear`, `has` — [`functionCache.ts`](../src/cache/functionCache.ts)

### `InMemoryDependencyIndex`

`get`, `set`, `delete`, `clear`, `all`, `size` — [`dependencyIndex.ts`](../src/cache/dependencyIndex.ts)

### `DiskCache` / `NoOpDiskCache`

`load`, `save`, `get`, `set`, `invalidate`, `clear` — interface + no-op — [`diskCache.ts`](../src/cache/diskCache.ts)

### `FileSystemDiskCache`

`load`, `save`, `get`, `set`, `invalidate`, `clear` — JSON under `~/.codemap/cache`, 24h TTL — [`fsDiskCache.ts`](../src/cache/fsDiskCache.ts)

---

## Shared messages

### `parseExtensionToWebview` / `parseWebviewToExtension`

| | |
|--|--|
| **File** | [`shared/messages.ts`](../shared/messages.ts) ~L108 |
| **Purpose** | Strict Zod parse (throws) |

### `safeParseExtensionToWebview` / `safeParseWebviewToExtension`

| | |
|--|--|
| **Purpose** | Non-throwing Zod parse |
| **Called by** | MessageBus (inbound), webview hook (inbound) |

---

## Utils

### `normalizePath` / `toPosix` / `relativePosix` / `joinPosix` / `ensureAbsolute`

| | |
|--|--|
| **File** | [`src/utils/path.ts`](../src/utils/path.ts) |
| **Purpose** | Cross-platform path identity for graph ids |

### `contentHash` / `fileMtimeMs`

| | |
|--|--|
| **File** | [`src/utils/hash.ts`](../src/utils/hash.ts) |
| **Purpose** | Cache keys / listing metadata |
| **Side effects** | Reads file from disk |

---

## Webview

### `postToExtension`

| | |
|--|--|
| **File** | [`src/webview/hooks/useExtensionMessages.ts`](../src/webview/hooks/useExtensionMessages.ts) ~L22 |
| **Purpose** | `acquireVsCodeApi().postMessage` |
| **Called by** | App, ArchitectureGraph |

---

### `useExtensionMessages`

| | |
|--|--|
| **File** | ~L33 |
| **Purpose** | React hook: snapshot state + message listener + send `ready` |
| **Returns** | `{ snapshot, lastPatch, fullVersion, progress, error, layoutEngine, setLayoutEngine, clearLastPatch }` |
| **Called by** | `App` |

---

### `layoutGraph`

| | |
|--|--|
| **File** | [`src/webview/layout/autoLayout.ts`](../src/webview/layout/autoLayout.ts) ~L33 |
| **Purpose** | Full layout: ELK (2s timeout) then Dagre fallback |
| **Returns** | `Promise<LayoutResult>` |
| **Called by** | ArchitectureGraph on `fullVersion` change |

---

### `layoutNewNodes`

| | |
|--|--|
| **File** | ~L53 |
| **Purpose** | Place only new nodes near parents; keep existing positions |
| **Called by** | ArchitectureGraph on patch |

---

### `nodeSize`

| | |
|--|--|
| **File** | ~L26 |
| **Purpose** | Width/height by NodeKind for layout engines |

---

### `ArchitectureGraph`

| | |
|--|--|
| **File** | [`src/webview/components/ArchitectureGraph.tsx`](../src/webview/components/ArchitectureGraph.tsx) ~L354 |
| **Purpose** | React Flow wrapper (provider + inner) |
| **Calls** | `layoutGraph`, `layoutNewNodes`, `postToExtension`, node components |

**Key internal behaviors:** full layout effect; patch layout effect; `onNodeDoubleClick` expand/collapse; modifier+double-click open.

---

### `kindToNodeType` + node components

| | |
|--|--|
| **File** | [`src/webview/components/Nodes.tsx`](../src/webview/components/Nodes.tsx) |
| **Purpose** | Map NodeKind → React Flow type string; render shells |

---

### `App`

| | |
|--|--|
| **File** | [`src/webview/App.tsx`](../src/webview/App.tsx) |
| **Purpose** | Shell UI; wires hook → ArchitectureGraph; Refresh button |

---

## Stubs / reserved

| File | Exports | Status |
|------|---------|--------|
| `src/scanner/detector.ts` | — | Empty |
| `src/scanner/fileIndex.ts` | — | Empty |
| `src/scanner/fileWalker.ts` | — | Empty |
| `src/scanner/projectScanner.ts` | — | Empty |
| `src/commands/scanProject.ts` | — | Empty |
| `src/utils/fs.ts` | — | Empty |

`src/cache/diskCache.ts` and `fsDiskCache.ts` are production code (`FileCache` uses `FileSystemDiskCache`). Do not call the empty stubs above expecting production behavior.

---

## Related docs

- [05-module-breakdown.md](05-module-breakdown.md)
- [15-common-workflows.md](15-common-workflows.md)
