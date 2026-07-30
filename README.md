# CodeMap

Interactive VS Code extension that visualizes a workspace as a progressive architecture explorer (React Flow + ELK).

## Current (incremental explorer)

- **No full-workspace parse on open** — startup lists root folders/files only (&lt;200ms target)
- Double-click to expand folders → files → symbols → call flow (n8n-style)
- Ctrl/Cmd+double-click opens the file in the editor
- Three-layer caches: folder listings, parsed files, function callees
- File watcher invalidates only changed paths
- Background prefetch parses visible files after folder expand (low priority)
- Worker-thread TypeScript parser (imports, exports, symbols, direct calls)
- Manual **CodeMap: Open Architecture** / **CodeMap: Refresh Graph** (re-explores expanded nodes)

Static analysis only — dynamic dispatch and runtime-only calls are not shown (banner in UI).

## Develop

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host, then run **CodeMap: Open Architecture**.

```bash
npm run test:unit   # fixture + protocol tests
npm run watch       # rebuild on change
npm run typecheck
```

## Architecture

```
Extension host → ExplorerService → listDirectory / WorkerPool
                 → FolderCache / FileCache / FunctionCache
                 → graph:full | graph:patch → Webview (React Flow)
```

Shared zod-validated protocol: [`shared/messages.ts`](shared/messages.ts).

## Interaction model

| Action | Effect |
|--------|--------|
| Open panel | Workspace + root children only |
| Double-click folder | Immediate children (cached) |
| Double-click file | Parse AST → symbols + import stubs |
| Double-click function | Immediate callees (file stub if target unexpanded) |
| Expand target file later | Rewire call edges to concrete symbols |
| Refresh | Re-validate caches for explored paths |

## Roadmap

| Phase | Focus |
|-------|--------|
| Done | Lazy explorer, caches, watcher, prefetch, call edges |
| Next | Disk cache persistence, search/filter UI, multi-worker pool |

The older multi-phase Next.js plan in `plan.md` is superseded by this roadmap.
