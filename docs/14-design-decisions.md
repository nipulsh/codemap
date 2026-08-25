# 14 — Design Decisions

Architectural choices, reasons, and trade-offs.

---

## 1. Lazy explorer instead of full-workspace parse on open

**Decision:** Bootstrap lists only the workspace root’s immediate children.

**Why:** Large monorepos make “parse everything” startup multi-second or worse. The product goal is interactive exploration, not a static billboard.

**Trade-offs:**

- (+) Fast first paint; scales with what the user opens.
- (−) No global “whole repo” view until the user expands.
- (−) Import stubs appear before targets are expanded.

**Alternative rejected:** Always run `scanWorkspace` + `generateGraph` on open (still available for tests).

---

## 2. Worker threads for parsing

**Decision:** Run TypeScript AST work in a Node worker via `WorkerPool`.

**Why:** Keep the extension host responsive during parse and prefetch.

**Trade-offs:**

- (+) UI stays usable; crashes in worker can be isolated/restarted.
- (−) IPC overhead; harder debugging; duplicate bundle.
- (−) Currently a **single** worker — throughput limited (roadmap: multi-worker).

---

## 3. TypeScript compiler API as the parser

**Decision:** Use `typescript` package (`createSourceFile`, `resolveModuleName`) rather than regex or a third-party JS parser alone.

**Why:** Correct-enough module resolution with path aliases and tsconfig; first-class TS/TSX support.

**Trade-offs:**

- (+) Aligns with how the language actually resolves imports.
- (−) Heavy dependency; version coupling; not a full typechecker program for every file (speed choice).
- (−) Dynamic patterns still invisible.

---

## 4. Zod-validated shared message protocol

**Decision:** Define messages and graph shapes in `shared/` with Zod; validate at the boundary.

**Why:** Webview and host are separate JS worlds. Invalid messages should fail loudly with `scope: 'message-bus'` rather than corrupt state.

**Trade-offs:**

- (+) Contract clarity; safer evolution.
- (−) Slight runtime cost; schemas must be updated for new features first.

---

## 5. React Flow + ELK (Dagre fallback)

**Decision:** Render with `@xyflow/react`; layout with ELK layered LR; fall back to Dagre after 2s or failure; patches use incremental placement.

**Why:** React Flow gives pan/zoom/drag/custom nodes quickly. ELK produces readable layered graphs; Dagre is a reliable backup. Full relayout on every patch would destroy user-arranged positions.

**Trade-offs:**

- (+) Good UX for progressive expand.
- (−) Two layout libs in the bundle.
- (−) Incremental placement is heuristic (may overlap in dense graphs).

---

## 6. Three-layer cache + disk persistence

**Decision:** FolderCache + FileCache (hash-fresh, disk-backed) + FunctionCache; persist file parses via `FileSystemDiskCache`.

**Why:** Different invalidation granularities. Expanding a folder should not re-parse; expanding a function should not re-list directories; editing a file should not wipe unrelated folders. Disk backing warms the second session without restoring graph UI state.

**Trade-offs:**

- (+) Responsive re-expand / refresh; faster re-parse after restart.
- (−) Memory grows with exploration (acceptable while panel lives).
- (−) Disk cache is parse-only; expansion session is not restored.
- (−) Filename-sanitized keys and TTL (24h) are simple, not a full content-addressed store.

---

## 7. Single worker + priority queue (not multi-worker yet)

**Decision:** One worker; high priority inserts ahead of low (prefetch).

**Why:** Simpler correctness; still protects interactive latency from background work.

**Trade-offs:**

- (+) Predictable; easy dispose.
- (−) Prefetch and user work still serialize on one CPU worker.
- **Roadmap:** multi-worker pool.

---

## 8. Static analysis only

**Decision:** Show only statically resolvable imports/calls; banner warns about dynamic dispatch.

**Why:** Honest visualization beats fake completeness. Runtime graphs need instrumentation outside this extension’s scope.

**Trade-offs:**

- (+) Trustworthy edges.
- (−) Incomplete for highly dynamic codebases.

---

## 9. Hardcoded ignore rules (Phase 1)

**Decision:** `ignore.ts` hardcodes `node_modules`, `dist`, tests, etc. Filter UI schemas exist but are no-ops.

**Why:** Ship a sensible default without building filter UX yet.

**Trade-offs:**

- (+) Less noise out of the box.
- (−) Users cannot yet customize via UI (`filter:update` reserved).

---

## 10. Panel owns composition; explorer owns domain logic

**Decision:** `ArchitecturePanel` wires VS Code; `ExplorerService` owns graph semantics.

**Why:** Testable domain logic (incremental tests) without mocking webviews; clear disposal boundary.

---

## Where to add features (decision-aligned)

| Feature | Put it here | Avoid |
|---------|-------------|-------|
| New message | `shared/messages.ts` first | Ad-hoc untyped posts |
| New node kind | `shared/graph.ts` + Nodes + explorer | Webview-only kinds |
| Faster open | Keep lazy listing | Accidental full scan in bootstrap |
| Persistence | Extend `DiskCache` / `FileSystemDiskCache` | Ad-hoc writes from the webview |
| Search | Host query + `search:results` | Client-only fake index |

## Related docs

- [01-project-overview.md](01-project-overview.md)
- [09-database.md](09-database.md)
- [10-workers.md](10-workers.md)
