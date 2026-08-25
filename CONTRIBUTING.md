# Contributing to CodeMap

Thanks for contributing. This guide covers the shortest path from clone to a useful pull request.

## Ways to help

- Report bugs and reproduce issues
- Suggest features with a clear user story
- Improve documentation under `docs/` and the root README
- Fix bugs or add features with tests
- Review PRs and verify Extension Development Host behavior

## Prerequisites

- Node.js 18+
- npm
- Visual Studio Code 1.85+ (recommended for F5 debugging)

## Getting started

```bash
git clone https://github.com/nipulsh/codemap.git
cd codemap
npm install
npm run compile
```

Create a branch:

```bash
git checkout -b feature-or-fix-name
```

Press **F5** to open the Extension Development Host, then run **CodeMap: Open Architecture**.

## Development scripts

| Script | Purpose |
|--------|---------|
| `npm run compile` | Bundle extension, worker, webview |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc` for extension + webview |
| `npm run test:unit` | Unit / fixture tests |
| `npm run lint` | ESLint |
| `npm test` | VS Code integration test runner |

## Project layout (short)

| Path | Role |
|------|------|
| `src/extension/` | Activation, panel, message bus |
| `src/explorer/` | Lazy expand / collapse / patches |
| `src/parser/` | Worker pool + AST extraction |
| `src/cache/` | Folder / file / function / disk caches |
| `shared/` | Zod graph + message contracts |
| `src/webview/` | React Flow UI |
| `docs/` | Internal architecture docs |

Start with [docs/README.md](docs/README.md) if you are new to the codebase. Treat `shared/messages.ts` and `shared/graph.ts` as the contract — update schemas before host or webview behavior.

## Code style

- TypeScript strict mode; match existing naming
- Prefer small, focused functions
- JSDoc public APIs you introduce
- Add or extend unit tests under `tests/` for parser, protocol, and graph behavior
- Do not commit secrets or local cache directories

## Pull requests

1. Run `npm run typecheck`, `npm run lint`, and `npm run test:unit` locally
2. Update docs when behavior or architecture changes
3. Describe **why** in the PR body; link related issues
4. Keep PRs focused — one concern per PR when practical

### Commit messages

Prefer short, imperative summaries:

- `add disk-backed FileCache persistence`
- `fix call edge rewiring when target expands`
- `docs: align storage docs with FileSystemDiskCache`

## Reporting issues

Include:

- OS and VS Code version
- Steps to reproduce
- Expected vs actual behavior
- Relevant Output / Extension Host logs
- Screenshots of the graph when useful

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
