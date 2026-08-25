# Change Log

## [Unreleased]

- Added persistent disk cache layer (`FileSystemDiskCache`) to survive VS Code restarts
- Enhanced `FileCache` with async methods and disk backing
- Updated `ExplorerService` and background prefetch to use async cache operations
- Rewrote professional README (features, quick start, architecture, roadmap, docs index)
- Aligned internal docs with disk cache (`09-database`, architecture, state, design decisions)
- Added `docs/CACHE_IMPROVEMENTS_SUMMARY.md`
- Polished `CONTRIBUTING.md` and MIT `LICENSE`

## [0.1.0] — Phase 1

- Open Architecture webview with folder/file dependency graph
- Worker-thread TypeScript import/export parsing
- ELK layout with Dagre fallback
- Fixture-based unit tests for barrels, aliases, cycles, dynamic imports, monorepos