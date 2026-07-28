# CodeMap

Interactive VS Code extension that visualizes a workspace as a folder/file dependency graph (React Flow + ELK).

## Phase 1 (current)

- Full workspace scan with hardcoded ignores (`node_modules`, `.next`, `dist`, `build`, `coverage`, tests, generated)
- Folder + file nodes; edges for static imports/exports and dynamic `import()`
- Barrel re-exports resolved one hop; path aliases via `tsconfig` `paths`
- Circular dependencies marked in graph metadata
- Parsing runs in a Node `worker_threads` worker
- Manual **CodeMap: Open Architecture** / **CodeMap: Refresh Graph** (no file watching yet)
- Dark-mode webview, pan/zoom/minimap, collapsible folders, double-click file to open

**Not in Phase 1:** live incremental updates, on-disk cache, function/call graph, search, filter UI, deep (ts-morph) mode.

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
Extension host → WorkspaceScanner → WorkerPool (TS parser)
                 → DependencyIndex → GraphGenerator → Webview (React Flow)
```

Shared zod-validated protocol: [`shared/messages.ts`](shared/messages.ts).

## Roadmap

| Phase | Focus |
|-------|--------|
| 1 | Static folder + file graph (this release) |
| 2 | File watcher, disk cache, incremental `graph:patch` |
| 3 | Function/component nodes, call edges, search, filters |
| 4 | Scale/polish (tooltips, shortcuts, large-repo targets) |

The older multi-phase Next.js plan in `plan.md` is superseded by this roadmap.
