# 02 — Folder Structure

This page documents every important folder in the repo and why it exists.

```mermaid
flowchart TB
  root[codemap/]
  root --> shared[shared/]
  root --> src[src/]
  root --> tests[tests/]
  root --> out[out/ build]
  root --> vscode[.vscode/]
  root --> docs[docs/]
  src --> extension[extension/]
  src --> explorer[explorer/]
  src --> scanner[scanner/]
  src --> parser[parser/]
  src --> graph[graph/]
  src --> cache[cache/]
  src --> webview[webview/]
  src --> utils[utils/]
  src --> commands[commands/]
  src --> types[types/]
```

---

## Repository root

| Path | Why it exists |
|------|----------------|
| `package.json` | Extension metadata, commands, scripts, dependencies |
| `esbuild.mjs` | Builds three bundles: extension, worker, webview |
| `tsconfig.json` | Typecheck host + shared + tests (excludes webview) |
| `tsconfig.webview.json` | Typecheck webview + shared (DOM libs) |
| `README.md` | User-facing product summary |
| `plan.md` | Older roadmap notes (partially superseded) |
| `docs/` | This documentation set |

**Used by:** developers and VS Code packaging (`main`: `./out/extension.js`).

---

## `shared/`

**Responsible for:** contracts shared by the extension host **and** the webview (and tests).

**Contains:**

| File | Role |
|------|------|
| `shared/graph.ts` | Node/edge/snapshot/patch Zod schemas; `applyGraphPatch` |
| `shared/messages.ts` | Extension↔webview message protocol + parse helpers |

**Why separate from `src/`?** Both bundles import these types. Putting them in `shared/` avoids circular “host-only” assumptions and keeps the protocol the single source of truth.

**Used by:** `ArchitecturePanel`, `MessageBus`, `ExplorerService`, webview hooks/components, `tests/messages.test.ts`.

**Dependencies:** `zod` only.

---

## `src/extension/`

**Responsible for:** VS Code lifecycle and the webview panel host.

| File | Role |
|------|------|
| `activate.ts` | `activate` / `deactivate`; register commands |
| `ArchitecturePanel.ts` | Singleton panel; wires bus, pool, explorer, watcher |
| `messageBus.ts` | Zod-validated `postMessage` wrapper |

**Also:** `src/extension.ts` re-exports activate/deactivate for tooling convenience. The **real** esbuild entry is `src/extension/activate.ts` → `out/extension.js`.

**Used by:** VS Code loads `out/extension.js`.

**Depends on:** explorer, parser worker pool, scanner ignore helpers, utils/path, shared messages.

---

## `src/explorer/`

**Responsible for:** progressive exploration — the product’s core orchestration.

| File | Role |
|------|------|
| `ExplorerService.ts` | bootstrap, expand/collapse, refresh, FS invalidation, emit patches |
| `prefetch.ts` | `BackgroundPrefetch` — low-priority parse into FileCache |

**Used by:** `ArchitecturePanel` only (live path).

**Depends on:** caches, listDirectory, WorkerPool, graph/incremental helpers, hash/path utils.

---

## `src/scanner/`

**Responsible for:** discovering files/folders on disk.

| File | Role |
|------|------|
| `listDirectory.ts` | **Live path** — non-recursive listing |
| `workspaceScanner.ts` | **Test/full path** — recursive scan |
| `ignore.ts` | Ignore dirs/files; `isSourceFile` |
| `types.ts` | `ScannedFile`, `TsConfigInfo`, `ScanResult` |
| `detector.ts`, `fileIndex.ts`, `fileWalker.ts`, `projectScanner.ts` | **Empty stubs** (reserved) |

**Used by:** ExplorerService (`listDirectory`); tests (`workspaceScanner`).

---

## `src/parser/`

**Responsible for:** TypeScript AST analysis and worker IPC.

| File | Role |
|------|------|
| `types.ts` | Parse/worker DTOs |
| `extractImports.ts` | `parseFiles`, `parseFile`, `resolveCalls` |
| `extractSymbols.ts` | `extractSymbols`, `resolveFunctionCallees` |
| `workerPool.ts` | Host-side single-worker priority queue |
| `workers/parseWorker.ts` | Worker entrypoint (bundled separately) |

**Used by:** ExplorerService, BackgroundPrefetch; tests call extractors via helpers or pool-free paths.

**Build output:** `out/parser/workers/parseWorker.js`.

---

## `src/graph/`

**Responsible for:** turning parsed data into graph structures.

| File | Role |
|------|------|
| `incremental.ts` | ID helpers, `makeNode`/`makeEdge`, patch maps — **live path** |
| `generator.ts` | `generateGraph`, `detectCycles` — **full snapshot / tests** |

**Used by:** ExplorerService (incremental); tests (generator).

---

## `src/cache/`

**Responsible for:** in-memory memoization and disk-backed parse persistence.

| File | Role |
|------|------|
| `folderCache.ts` | Directory listings |
| `fileCache.ts` | Parsed file results + content-hash freshness + disk backing |
| `functionCache.ts` | Function → callees |
| `dependencyIndex.ts` | Full-index API for `generateGraph` (tests) |
| `diskCache.ts` | `DiskCache` interface + `NoOpDiskCache` |
| `fsDiskCache.ts` | `FileSystemDiskCache` — JSON files under `~/.codemap/cache` |

**Used by:** ExplorerService, prefetch; tests use dependency index.

**Durable storage:** file parse results only — see [09-database.md](09-database.md).

---

## `src/webview/`

**Responsible for:** the React UI inside the VS Code webview.

| Path | Role |
|------|------|
| `index.tsx` | React mount |
| `App.tsx` | Toolbar, progress/error, graph host |
| `hooks/useExtensionMessages.ts` | Message subscription + snapshot state |
| `components/ArchitectureGraph.tsx` | React Flow canvas + interactions |
| `components/Nodes.tsx` | Custom node components |
| `layout/autoLayout.ts` | ELK / Dagre / incremental placement |
| `styles.css` | Theming with VS Code CSS variables |
| `css.d.ts` | CSS import typing |

**Build output:** `out/webview/main.js` (+ CSS copy).

**Depends on:** `@xyflow/react`, `elkjs`, `@dagrejs/dagre`, `shared/*`. Must not import `vscode` Node APIs.

---

## `src/utils/`

| File | Role |
|------|------|
| `path.ts` | POSIX normalize, join, absolute helpers |
| `hash.ts` | Content hash + mtime for cache keys |
| `fs.ts` | **Empty stub** |

**Used by:** scanner, explorer, caches, graph.

---

## `src/commands/`

| File | Role |
|------|------|
| `scanProject.ts` | **Empty stub** — commands currently live in `activate.ts` |

---

## `src/types/`

| File | Role |
|------|------|
| `graph.ts` | Re-exports shared graph/message types for host convenience |

---

## `src/test/`

| File | Role |
|------|------|
| `extension.test.ts` | Extension-host smoke test (commands registered) |

Run via `npm test` (vscode-test), distinct from `npm run test:unit`.

---

## `tests/`

**Responsible for:** fast unit/fixture tests without a full Extension Host.

| Area | Coverage |
|------|----------|
| `basic-imports`, `barrel-reexport`, `circular`, `dynamic-import`, `path-alias`, `monorepo-two-tsconfig` | Full-graph pipeline |
| `incremental.test.ts` | listDirectory, caches, patches, call resolve |
| `messages.test.ts` | Zod protocol |
| `helpers.ts` + `fixtures/` | Shared builders + mini projects |

---

## `out/`

**Responsible for:** compiled/bundled artifacts consumed at runtime.

| Artifact | Source |
|----------|--------|
| `out/extension.js` | `src/extension/activate.ts` |
| `out/parser/workers/parseWorker.js` | `src/parser/workers/parseWorker.ts` |
| `out/webview/main.js` | `src/webview/index.tsx` |

Do not hand-edit `out/`. Always rebuild with `npm run compile` or `watch`.

---

## `.vscode/`

| File | Role |
|------|------|
| `launch.json` | F5 → Extension Development Host |
| `tasks.json` | Default build task for preLaunch |
| `settings.json` / `extensions.json` | Workspace editor settings |

---

## Where to add new features

| Feature idea | Primary folders |
|--------------|-----------------|
| New expand behavior | `src/explorer/` |
| New AST insight | `src/parser/` |
| New UI interaction | `src/webview/components/` |
| New message | `shared/messages.ts` then panel + hook |
| New node/edge kind | `shared/graph.ts` + Nodes + explorer + styles |
| Persistence | `src/cache/diskCache.ts` (implement for real) |

See [14-design-decisions.md](14-design-decisions.md) for trade-offs.
