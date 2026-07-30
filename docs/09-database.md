# 09 — Database / Storage

## Verdict

**There is no database.** CodeMap does not use SQLite, Postgres, Prisma, MongoDB, or any other durable store.

This page documents what *does* exist for storage and I/O so you do not hunt for a persistence layer that is not wired up.

---

## Storage matrix

| Mechanism | Present? | Role |
|-----------|----------|------|
| SQL / NoSQL database | **No** | — |
| VS Code `globalState` / `workspaceState` | **No** | Not used |
| Webview `getState` / `setState` | Typed only | Declared on `acquireVsCodeApi`; **not called** |
| Disk cache file | **Stub** | `NoOpDiskCache` in [`src/cache/diskCache.ts`](../src/cache/diskCache.ts) |
| In-memory caches | **Yes** | Folder / File / Function caches |
| Filesystem reads | **Yes** | `listDirectory`, scanners, hash, parser |
| Filesystem writes (app data) | **No** | Extension does not write a cache DB |
| Editor open | **Yes** | `node:open` opens user files via VS Code APIs |

---

## In-memory caches (primary “storage”)

Owned by `ExplorerService`:

1. **FolderCache** — directory listings keyed by normalized path.
2. **FileCache** — parse results keyed by path; validated with `contentHash`.
3. **FunctionCache** — callee lists keyed by symbol `nodeId`.

Additionally, tests use **`InMemoryDependencyIndex`** for the full-graph pipeline.

All of these are process-local and die when the panel disposes or the Extension Host restarts.

---

## Filesystem usage

| Operation | Module | Mode |
|-----------|--------|------|
| List directory | `listDirectory` / `workspaceScanner` | Read |
| Content hash / mtime | `utils/hash` | Read |
| Parse source | `extractImports` via `fs` read inside TS APIs / file load | Read |
| Watch changes | `vscode.FileSystemWatcher` | Events |
| Open in editor | `openTextDocument` / `showTextDocument` | User file |

Ignored paths (not listed): `node_modules`, `.next`, `dist`, `build`, `coverage`, `.git`, `out`, etc. — see [`src/scanner/ignore.ts`](../src/scanner/ignore.ts).

---

## Disk cache stub (Phase 2)

[`src/cache/diskCache.ts`](../src/cache/diskCache.ts) defines:

```ts
interface DiskCache {
  // API reserved for persistence
}
class NoOpDiskCache implements DiskCache {
  // all methods no-op
}
```

**Assumption:** Roadmap item “Disk cache persistence” will implement real read/write behind this interface. Today nothing calls it in the live path.

---

## Graph persistence

The graph exists in:

1. Explorer host maps
2. Webview React snapshot

Closing the panel clears both (after dispose). There is no “save graph” or “load previous session.”

---

## Indexed data

“Index” in this codebase means:

- **Dependency index** (`InMemoryDependencyIndex`) — map of parsed files for `generateGraph` (tests).
- **Not** a search index on disk.

Search UI messages (`search:query` / `search:results`) are schema placeholders only.

## Related docs

- [08-state-management.md](08-state-management.md)
- [14-design-decisions.md](14-design-decisions.md)
