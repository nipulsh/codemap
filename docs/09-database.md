# 09 — Database / Storage

## Verdict

**There is no SQL/NoSQL database.** CodeMap does not use SQLite, Postgres, Prisma, MongoDB, or similar.

It **does** persist parsed file results on disk via `FileSystemDiskCache`, and keeps folder / function results in memory for the life of the panel.

---

## Storage matrix

| Mechanism | Present? | Role |
|-----------|----------|------|
| SQL / NoSQL database | **No** | — |
| VS Code `globalState` / `workspaceState` | **No** | Not used |
| Webview `getState` / `setState` | Typed only | Declared on `acquireVsCodeApi`; **not called** |
| Disk cache files | **Yes** | `FileSystemDiskCache` → `~/.codemap/cache/*.json` |
| In-memory caches | **Yes** | Folder / File / Function caches |
| Filesystem reads | **Yes** | `listDirectory`, scanners, hash, parser |
| Filesystem writes (app data) | **Yes** | Parse-result JSON under the cache directory |
| Editor open | **Yes** | `node:open` opens user files via VS Code APIs |

---

## In-memory caches (primary hot path)

Owned by `ExplorerService`:

1. **FolderCache** — directory listings keyed by normalized path.
2. **FileCache** — parse results keyed by path; validated with `contentHash`; backed by disk.
3. **FunctionCache** — callee lists keyed by symbol `nodeId`.

Additionally, tests use **`InMemoryDependencyIndex`** for the full-graph pipeline.

Folder and function maps are process-local and die when the panel disposes or the Extension Host restarts. File parse results can be restored from disk on the next session.

---

## Disk cache (parse persistence)

[`src/cache/diskCache.ts`](../src/cache/diskCache.ts) defines the `DiskCache` interface and `NoOpDiskCache` (for tests / disabling persistence).

[`src/cache/fsDiskCache.ts`](../src/cache/fsDiskCache.ts) implements:

| Behavior | Detail |
|----------|--------|
| Location | `~/.codemap/cache` by default |
| Format | One JSON file per key (`{ data, timestamp }`) |
| TTL | 24 hours (configurable in constructor) |
| API | `load`, `save`, `get`, `set`, `invalidate`, `clear` |

[`FileCache`](../src/cache/fileCache.ts) uses `FileSystemDiskCache`:

- Sync `get` — memory only (fast path).
- `getAsync` — memory, then disk.
- `set` / `setAsync` — memory + disk write-through.
- `invalidate` / `clear` — both layers.

See [CACHE_IMPROVEMENTS_SUMMARY.md](CACHE_IMPROVEMENTS_SUMMARY.md) for the design summary.

---

## Filesystem usage

| Operation | Module | Mode |
|-----------|--------|------|
| List directory | `listDirectory` / `workspaceScanner` | Read |
| Content hash / mtime | `utils/hash` | Read |
| Parse source | `extractImports` via TS APIs / file load | Read |
| Persist parse cache | `FileSystemDiskCache` | Read / write |
| Watch changes | `vscode.FileSystemWatcher` | Events |
| Open in editor | `openTextDocument` / `showTextDocument` | User file |

Ignored paths (not listed): `node_modules`, `.next`, `dist`, `build`, `coverage`, `.git`, `out`, etc. — see [`src/scanner/ignore.ts`](../src/scanner/ignore.ts).

---

## Graph persistence

The **graph layout and expansion state** exist in:

1. Explorer host maps
2. Webview React snapshot

Closing the panel clears those. There is no “save graph” or “restore previous expansion.” Disk cache only restores **parse results**, so re-expanding a file after restart can skip re-parsing when the hash still matches.

---

## Indexed data

“Index” in this codebase means:

- **Dependency index** (`InMemoryDependencyIndex`) — map of parsed files for `generateGraph` (tests).
- **Not** a search index on disk.

Search UI messages (`search:query` / `search:results`) are schema placeholders only.

## Related docs

- [08-state-management.md](08-state-management.md)
- [14-design-decisions.md](14-design-decisions.md)
- [CACHE_IMPROVEMENTS_SUMMARY.md](CACHE_IMPROVEMENTS_SUMMARY.md)
