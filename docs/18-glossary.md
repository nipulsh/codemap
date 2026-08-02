# 18 — Glossary

Important CodeMap concepts in plain language.

---

### AST (Abstract Syntax Tree)

Tree representation of source code produced by the TypeScript parser. CodeMap walks ASTs to find imports, exports, symbols, and call expressions — it does not execute your program.

### ArchitecturePanel

Singleton VS Code webview host that owns the MessageBus, WorkerPool, ExplorerService, and filesystem watcher. File: `src/extension/ArchitecturePanel.ts`.

### Background Prefetch

After a folder expands, low-priority parsing of visible source files into FileCache without updating the graph. Speeds up later file expands.

### Barrel hop

When file A re-exports from file B, dependency resolution may “hop” one level so A’s effective dependency points at B’s underlying module rather than only the barrel file. Implemented in the import extractor.

### Cache (Folder / File / Function / Disk)

- **FolderCache** — in-memory directory listings
- **FileCache** — parse results keyed by path + content hash; backed by disk
- **FunctionCache** — callee lists keyed by symbol node id
- **FileSystemDiskCache** — JSON files under `~/.codemap/cache` (24h TTL)

Not a SQL database. See [09-database.md](09-database.md) and [CACHE_IMPROVEMENTS_SUMMARY.md](CACHE_IMPROVEMENTS_SUMMARY.md).

### Call Graph

Edges of kind `calls` from a function/symbol node to callees (other symbols or file stubs). Built on demand via `expandFunction` / `resolveCalls`.

### CalleeRef

Parser DTO describing a single callee: name, optional `targetFile`, `local` flag, optional `async` heuristic.

### Content hash

Short SHA-256 prefix of file bytes (`contentHash`) used to decide if a FileCache entry is still fresh.

### Dependency Graph / Dependency Index

- **Graph edges** `imports` / `dynamicImport` between file nodes.
- **InMemoryDependencyIndex** — map of parsed files used by the full `generateGraph` test pipeline.

### Edge / GraphEdge

Directed link between two nodes with a `kind` (`hierarchy`, `contains`, `imports`, `exports`, `calls`, `dynamicImport`) and stable `id`.

### EdgeKind

Enum of allowed edge types in `shared/graph.ts`.

### ELK

Eclipse Layout Kernel (`elkjs`). Primary automatic layout engine (layered, left-to-right). Falls back to Dagre on failure/timeout.

### ExplorerService

Core orchestrator for lazy expand/collapse/refresh and patch emission. The product brain of CodeMap.

### Extension Host

VS Code process that runs extension code (`activate`, panel, workers). Distinct from the webview’s browser-like JS context.

### Graph Patch / GraphPatch

Incremental update: upsert/remove nodes and edges. Applied on the host maps and in the webview via `applyGraphPatch`.

### Graph Snapshot / GraphSnapshot

Full graph payload: all nodes, edges, `generatedAt`, optional `workspaceRoot`. Sent as `graph:full`.

### Hierarchy edge

Parent/child relationship in the folder tree (Workspace/Folder → Folder/File). Distinct from `contains` (File → symbol).

### Lazy file stub

A File node created as an import/call target before that file has been expanded. Often marked `metadata.lazy`. May later gain symbols when expanded.

### Message Bus

`MessageBus` class wrapping Zod validation around `webview.postMessage` / `onDidReceiveMessage`.

### Node / GraphNode

A vertex in the architecture graph with `id`, `kind`, `label`, optional `filePath`/`line`, and `metadata`.

### NodeKind

Workspace, Folder, File, Function, Class, Interface, Enum, Component.

### Parser

Code that turns source files into structured imports/symbols/calls (`extractImports`, `extractSymbols`), usually running inside the worker.

### React Flow

UI library (`@xyflow/react`) for interactive node-edge diagrams. Renders CodeMap’s custom node components.

### Scanner

Code that discovers files/folders on disk. Live path: `listDirectory`. Full path: `scanWorkspace`.

### Symbol / SymbolInfo

Named top-level declaration extracted from a file (function, class, …) with line and export flags. Becomes a graph node under its file via `contains`.

### tsconfig / TsConfigInfo

TypeScript config location (`configPath`) and directory (`baseDir`) used for module resolution and path aliases.

### Webview

Isolated HTML/JS page hosted inside VS Code. CodeMap’s React app runs here and talks to the host only through messages.

### Worker / Worker Pool

Node `worker_threads` Worker running `parseWorker.js`. `WorkerPool` queues jobs with high/low priority over a single worker.

### Worker IPC

Request/response messages (`parseFile`, `parseFiles`, `resolveCalls` ↔ results/errors) correlated by string `id`.

### Zod

Runtime schema validation library. Used for graph and message contracts so host and webview stay compatible.

---

## Related docs

- Start at [README.md](README.md) for reading order.
- Deep API detail: [12-function-reference.md](12-function-reference.md).
