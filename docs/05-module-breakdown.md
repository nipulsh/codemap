# 05 — Module Breakdown

Per-module deep dive for `shared/` and `src/`. For each: purpose, exports, key types, how others use it, internal flow.

---

## `shared/graph.ts`

**Purpose:** Canonical graph model shared by host, webview, and tests.

**Exports**

- Schemas/types: `NodeKind`, `EdgeKind`, `GraphNode`, `GraphEdge`, `GraphSnapshot`, `GraphPatch`, `SearchResult`, `FilterState` (+ Zod schemas)
- `applyGraphPatch(snapshot, patch)` — immutable merge

**How others use it**

- Explorer builds nodes/edges matching these shapes.
- Message payloads embed `GraphSnapshot` / `GraphPatch`.
- Webview merges patches with `applyGraphPatch`.

**Internal flow:** Zod defines shape; `applyGraphPatch` rebuilds maps then returns a new snapshot with updated `generatedAt`.

---

## `shared/messages.ts`

**Purpose:** Discriminated-union protocol between extension and webview.

**Exports**

- `ExtensionToWebview` / `WebviewToExtension` (+ schemas)
- `parse*` / `safeParse*` helpers

**How others use it**

- `MessageBus` validates both directions.
- Webview hook validates inbound; `postToExtension` sends outbound (typed, validated on host receive).

**Internal flow:** Zod `discriminatedUnion('type', …)`.

---

## `src/extension/activate.ts`

**Purpose:** Extension entrypoint.

**Exports:** `activate`, `deactivate`

**Key flow:** Register `codemap.openArchitecture` and `codemap.refreshGraph`.

**Used by:** VS Code via `out/extension.js`.

---

## `src/extension/ArchitecturePanel.ts`

**Purpose:** Orchestration hub for the architecture UI.

**Exports:** `ArchitecturePanel` class

**Key members:** `createOrShow`, `bootstrap`, `refresh`, `dispose`, private `handleWebviewMessage`, `handleFsEvent`, `setupWatcher`, `getHtml`

**How others use it:** Only `activate.ts` (and itself via `current`).

**Internal flow:** Constructor wires dependencies → HTML → listeners → watcher. Emit bridge maps `ExplorerEmit` to bus message types.

---

## `src/extension/messageBus.ts`

**Purpose:** Typed, validated postMessage layer.

**Exports:** `MessageBus`

**Key methods:** `post`, `onMessage`

**Internal flow:** Outbound throws on invalid (parse); inbound uses safeParse and posts `error` on failure.

---

## `src/explorer/ExplorerService.ts`

**Purpose:** Lazy exploration state machine.

**Exports:** `ExplorerService`, `ExplorerEmit`

**Key methods:** See [04-architecture.md](04-architecture.md) / [12-function-reference.md](12-function-reference.md).

**How others use it:** Instantiated only by `ArchitecturePanel`.

**Internal flow**

```
bootstrap → maps + full emit
expand* → ensure data → patch maps → emit patch
collapse* → collectDescendants → remove → emit patch
refresh → snapshot expanded sets → clear → bootstrap → re-expand
```

Private helpers: `ensureParsed`, `patch`, `trackChild`, `collectDescendants`, `rewireCallsToFile`, etc.

---

## `src/explorer/prefetch.ts`

**Purpose:** Speculative FileCache warming after folder expand.

**Exports:** `BackgroundPrefetch`

**Key methods:** `enqueueFiles`, `cancel`

**Internal flow:** Filter source → skip cached → chunk 8 → `parseFiles(priority: 'low')` → `fileCache.set`. Swallows batch errors.

---

## `src/scanner/listDirectory.ts`

**Purpose:** Shallow directory reads for the live explorer.

**Exports:** `listDirectory`, `findNearestTsConfig`, `workspaceLabel`, types `ListedFolder`, `DirectoryListing`

**Used by:** ExplorerService.

**Internal flow:** `readdirSync` → ignore dirs → classify files (source / explorer-visible / tsconfig) → sort.

---

## `src/scanner/workspaceScanner.ts`

**Purpose:** Recursive scan for full-graph tests.

**Exports:** `scanWorkspace`, `findTsConfigForFile`

**Used by:** `tests/helpers.ts` (not live panel).

**Internal flow:** Recursive `walkDirectory` with ignore rules.

---

## `src/scanner/ignore.ts`

**Purpose:** Hardcoded Phase-1 ignore rules.

**Exports:** `shouldIgnoreDirectory`, `shouldIgnoreFile`, `isSourceFile`

**Used by:** scanner, explorer, panel FS handler, prefetch.

---

## `src/scanner/types.ts`

**Purpose:** Shared scanner DTOs (`ScannedFile`, `TsConfigInfo`, `ScanResult`, progress callback type).

---

## `src/parser/types.ts`

**Purpose:** Parser and worker IPC DTOs (`ImportSpec`, `ExportSpec`, `SymbolInfo`, `CalleeRef`, `FileParseResult`, request/response unions).

---

## `src/parser/extractImports.ts`

**Purpose:** Core AST parse pipeline.

**Exports:** `parseFiles`, `parseFile`, `resolveCalls`

**Internal flow (simplified)**

1. Load tsconfigs / pick project for file.
2. `ts.createSourceFile` (disk or in-memory content).
3. Walk imports/exports; `ts.resolveModuleName` (skip node_modules).
4. `extractSymbols`.
5. One-hop barrel re-export resolution → `dependencyPaths`.
6. `resolveCalls` → `resolveFunctionCallees`.

**Used by:** `parseWorker` (always in production path); tests may call directly.

---

## `src/parser/extractSymbols.ts`

**Purpose:** Symbol extraction and callee resolution.

**Exports:** `extractSymbols`, `resolveFunctionCallees`

**Internal heuristics:** PascalCase + JSX usage → `Component`; functions/classes/interfaces/enums accordingly.

---

## `src/parser/workerPool.ts`

**Purpose:** Host-side job queue over one worker.

**Exports:** `WorkerPool`, input interfaces

**Key methods:** `parseFiles`, `parseFile`, `resolveCalls`, `dispose`

**Internal flow:** `enqueue` (high before low) → `pump` → `postMessage` → match response by `id` → resolve/reject Promise.

---

## `src/parser/workers/parseWorker.ts`

**Purpose:** Worker thread entry; dispatch to extractors.

**Exports:** none (side-effect script)

**Internal flow:** `parentPort.on('message')` → switch type → post result or error.

---

## `src/graph/incremental.ts`

**Purpose:** Live-graph identity and patch helpers.

**Exports:** ID helpers (`workspaceNodeId`, `folderNodeId`, `fileNodeId`, `symbolNodeId`, `edgeId`), `makeNode`, `makeEdge`, `emptyPatch`, `mergePatches`, `applyPatchToMaps`, `parentIdForPath`, `labelFromPath`, `rewireFileStubToSymbol`, re-export `applyGraphPatch`

**Used by:** ExplorerService heavily.

---

## `src/graph/generator.ts`

**Purpose:** Build a complete GraphSnapshot from indexed files (test path).

**Exports:** `generateGraph`, `detectCycles`

**Internal flow:** Ensure folder chains → file nodes → contains/imports/exports/dynamicImport edges → mark cycles in metadata.

---

## `src/cache/*`

### `folderCache.ts`

**Exports:** `FolderCache` — `get/set/invalidate/clear/has`

### `fileCache.ts`

**Exports:** `CachedFileParse`, `FileCache` — includes `getIfFresh`, `getAsync`, `setAsync`; backs memory with `FileSystemDiskCache`

### `functionCache.ts`

**Exports:** `CachedFunctionCalls`, `FunctionCache` — includes `invalidateFile`

### `dependencyIndex.ts`

**Exports:** `IndexedFile`, `DependencyIndex`, `InMemoryDependencyIndex`

### `diskCache.ts`

**Exports:** `DiskCache` interface, `NoOpDiskCache` (all methods no-op; useful for tests)

### `fsDiskCache.ts`

**Exports:** `FileSystemDiskCache` — persists entries as JSON under `~/.codemap/cache` (24h TTL)

---

## `src/utils/path.ts`

**Exports:** `toPosix`, `relativePosix`, `normalizePath`, `joinPosix`, `ensureAbsolute`

**Why:** Consistent forward-slash IDs across Windows/macOS/Linux.

---

## `src/utils/hash.ts`

**Exports:** `contentHash`, `fileMtimeMs`

**Why:** FileCache freshness without always re-parsing.

---

## `src/webview/index.tsx`

**Purpose:** `createRoot` → `<App />`.

---

## `src/webview/App.tsx`

**Purpose:** Chrome around the graph — title, Refresh, layout engine hint, progress/error, static-analysis banner.

**Exports:** `App`

---

## `src/webview/hooks/useExtensionMessages.ts`

**Purpose:** Bridge VS Code API ↔ React state.

**Exports:** `postToExtension`, `useExtensionMessages`

**State:** `snapshot`, `lastPatch`, `fullVersion`, `progress`, `error`, `layoutEngine`

**Internal flow:** On mount send `ready`; listen for messages; merge patches.

---

## `src/webview/components/ArchitectureGraph.tsx`

**Purpose:** React Flow integration and user gestures.

**Exports:** `ArchitectureGraph`

**Internal flow:** Sync snapshot → RF nodes/edges; full layout on `fullVersion`; incremental layout on `lastPatch`; double-click expand/collapse; Ctrl/Cmd+double-click open.

---

## `src/webview/components/Nodes.tsx`

**Purpose:** Visual shells per `NodeKind`.

**Exports:** node components + `kindToNodeType`

---

## `src/webview/layout/autoLayout.ts`

**Purpose:** Positioning algorithms.

**Exports:** `nodeSize`, `layoutGraph`, `layoutNewNodes`, related types

---

## Unfinished / reserved stubs

These files exist but are empty or no-op — **not** part of the live path:

| File | Status |
|------|--------|
| `src/scanner/detector.ts` | Empty stub |
| `src/scanner/fileIndex.ts` | Empty stub |
| `src/scanner/fileWalker.ts` | Empty stub |
| `src/scanner/projectScanner.ts` | Empty stub |
| `src/commands/scanProject.ts` | Empty stub |
| `src/utils/fs.ts` | Empty stub |

**Note:** `src/cache/diskCache.ts` + `fsDiskCache.ts` are live — `FileCache` uses `FileSystemDiskCache`. `NoOpDiskCache` remains for tests. Other stubs above are reserved for richer scanning / a dedicated scan command.

---

## Related docs

- [12-function-reference.md](12-function-reference.md)
- [04-architecture.md](04-architecture.md)
