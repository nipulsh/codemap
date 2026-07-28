# CodeMap roadmap (supersedes prior plan)

This file replaces the previous 17-phase Next.js vision. Implementation follows the architecture visualizer phases below.

## Phase 1 — Static Folder + File Graph (current)

Workspace scan, worker-thread import/export parsing, React Flow graph, ELK/Dagre layout, manual refresh.

## Phase 2 — Live Incremental Updates

File watcher, on-disk cache, incremental reparse + `graph:patch`.

## Phase 3 — Function-Call Graph, Search, Filters

Function/component nodes, limited static call edges, search, filter toggles.

## Phase 4 — Scale & Polish

Performance targets, tooltips, keyboard shortcuts, folder zoom polish.
