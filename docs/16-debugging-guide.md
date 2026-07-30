# 16 — Debugging Guide

How to investigate problems in CodeMap.

---

## Launch configuration

[`.vscode/launch.json`](../.vscode/launch.json) provides **Run Extension**:

1. Runs the default preLaunch build task (compile).
2. Opens an Extension Development Host with `--extensionDevelopmentPath`.
3. Maps `out/**/*.js` for breakpoints in compiled output (source maps are enabled in esbuild).

**Workflow**

```bash
npm install
npm run watch   # optional: rebuild on save
# Press F5
# In the new window: open a TS workspace → Command Palette → CodeMap: Open Architecture
```

---

## Where to put breakpoints

| Symptom | Break here first |
|---------|------------------|
| Panel never opens | `activate.ts` command handlers |
| Blank webview | `ArchitecturePanel.getHtml`, webview `index.tsx` |
| No graph after open | `ExplorerService.bootstrap`, `MessageBus.post` |
| Click does nothing | `ArchitectureGraph` double-click handler; `handleWebviewMessage` |
| Expand hangs | `WorkerPool.enqueue` / `pump`; worker may be stuck |
| Stale graph after edit | `handleFsEvent`, `onFileChanged` |
| Zod / invalid message | `MessageBus.onMessage` safeParse failure branch |
| Wrong layout | `layoutGraph`, `layoutNewNodes` |

Host breakpoints: set in `src/**` TypeScript (source maps) or corresponding `out/**`.

Webview breakpoints: use the webview Developer Tools (**Help → Toggle Developer Tools** is for the main window; for webviews use **Developer: Open Webview Developer Tools** from the Command Palette while the panel is focused).

---

## Logging strategy

There is no dedicated logger module today. Practical approaches:

1. Temporary `console.log` in the extension host (shows in **Debug Console** of the parent VS Code).
2. Temporary `console.log` in the webview (shows in Webview DevTools console).
3. Watch the UI **error banner** (`scope: message`) and **progress** text.
4. For protocol issues, log raw messages at MessageBus boundaries.

Remove debug logs before committing.

---

## How to trace a click end-to-end

1. Webview: confirm `postToExtension({ type: 'folder:expand', … })` fires.
2. Host: `MessageBus.onMessage` receives and parses successfully.
3. `handleWebviewMessage` switch hits the right case.
4. `ExplorerService.expand*` runs; inspect `nodeMap`/`edgeMap` size.
5. Emit bridge posts `graph:patch`.
6. Webview hook `safeParse` succeeds; `lastPatch` updates; RF nodes change.

If step 2 fails → Zod schema mismatch.  
If step 4 fails → cache/FS/parser.  
If step 6 fails → webview state/layout bug.

---

## Common bugs

| Bug | Likely cause | Check |
|-----|--------------|-------|
| “No workspace folder open” | Empty window | Open a folder |
| Worker fails immediately | `out/parser/workers/parseWorker.js` missing | `npm run compile` |
| Expand no-op on README | Non-source file | Expected — only source parses |
| Import edges missing | Unresolvable / node_modules skipped | Resolution rules in extractImports |
| Stale symbols after save | Watcher missed or hash cache | Refresh; breakpoint `onFileChanged` |
| Second bootstrap clears graph | `ready` + command both bootstrap | Usually OK after first completes; watch `busy` |
| Invalid webview message | Schema drift | Update `shared/messages.ts` both usages |
| ELK timeout → dagre | Large graph / slow layout | Expected fallback; check `layoutEngine` |
| Prefetch vs expand race | Single worker queue | High priority should win; inspect queue order |
| CSS missing / unstyled | Webview CSS not built/linked | Panel loads `out/webview/main.css` (esbuild emits it from CSS imports in `index.tsx`); confirm Network tab + `npm run compile` |

---

## Useful commands

```bash
npm run compile      # rebuild all bundles
npm run watch        # continuous rebuild
npm run typecheck    # host + webview tsc
npm run test:unit    # fixture + protocol tests (no UI)
npm test             # extension host smoke tests
npm run lint
```

Unit tests are the fastest way to debug parser/graph issues without F5:

- Import resolution → `tests/path-alias.test.ts`, `barrel-reexport.test.ts`
- Patches/caches → `tests/incremental.test.ts`
- Protocol → `tests/messages.test.ts`

---

## Important files for debugging

| Area | Files |
|------|-------|
| Orchestration | `ArchitecturePanel.ts`, `activate.ts` |
| Domain | `ExplorerService.ts` |
| IPC | `messageBus.ts`, `shared/messages.ts` |
| Parse | `workerPool.ts`, `extractImports.ts`, `parseWorker.ts` |
| UI | `ArchitectureGraph.tsx`, `useExtensionMessages.ts` |
| Build | `esbuild.mjs` |

---

## Mental model for “is it host or webview?”

- If **progress/error never appear**, messages may not cross → host/bus.
- If **banner shows host errors**, host threw → explorer/parser.
- If **data arrives but nodes wrong**, layout/RF conversion → webview.
- If **tests pass but UI fails**, panel wiring/watcher/webview only.

## Related docs

- [15-common-workflows.md](15-common-workflows.md)
- [10-workers.md](10-workers.md)
- [17-extension-lifecycle.md](17-extension-lifecycle.md)
