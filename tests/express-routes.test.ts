import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractExpressRoutes } from '../src/parser/extractRoutes.ts';
import { parseFile } from '../src/parser/extractImports.ts';
import { RouteAnalyzer } from '../src/routes/RouteAnalyzer.ts';
import { RouteGraphBuilder } from '../src/routes/RouteGraphBuilder.ts';
import { analyzeFixture, fixtureRoot, routesFromFixture } from './helpers.ts';

function extractFromFixtureFile(fileName: string) {
  const root = fixtureRoot('express-routes');
  const absolutePath = join(root, fileName);
  const content = readFileSync(absolutePath, 'utf8');
  const parsed = parseFile(
    root,
    { absolutePath },
    [{ configPath: join(root, 'tsconfig.json'), baseDir: root }],
  );
  return extractExpressRoutes({
    filePath: absolutePath,
    content,
    symbols: parsed.symbols,
    imports: parsed.imports,
  });
}

function findRoute(
  routes: ReturnType<typeof extractExpressRoutes>,
  method: string,
  path: string,
) {
  return routes.find((r) => r.method === method && r.path === path);
}

describe('extractExpressRoutes', () => {
  it('extracts basic app.get and app.post routes', () => {
    const routes = extractFromFixtureFile('basic.ts');
    assert.equal(routes.length, 2);
    const getUsers = findRoute(routes, 'GET', '/users');
    const createUser = findRoute(routes, 'POST', '/users');
    assert.ok(getUsers);
    assert.ok(createUser);
    assert.equal(getUsers.handlerSymbol, 'getUsers');
    assert.equal(getUsers.handlerResolved, true);
    assert.equal(getUsers.confidence, 'high');
  });

  it('extracts router.get with path params', () => {
    const routes = extractFromFixtureFile('router.ts');
    assert.equal(routes.length, 1);
    const route = findRoute(routes, 'GET', '/users/:id');
    assert.ok(route);
    assert.equal(route.routerVariable, 'router');
    assert.equal(route.handlerSymbol, 'getUser');
  });

  it('resolves static mount prefix app.use("/api", router)', () => {
    const routes = extractFromFixtureFile('mounted.ts');
    assert.equal(routes.length, 1);
    const route = findRoute(routes, 'GET', '/api/users');
    assert.ok(route, `expected GET /api/users, got ${routes.map((r) => r.path).join(', ')}`);
    assert.equal(route.mountPrefix, '/api');
    assert.equal(route.confidence, 'high');
  });

  it('handles inline arrow function handlers', () => {
    const routes = extractFromFixtureFile('inline.ts');
    assert.equal(routes.length, 1);
    const route = routes[0];
    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/health');
    assert.ok(route.handlerSymbol?.includes('inline-handler'));
    assert.equal(route.handlerResolved, true);
  });

  it('resolves controller member handlers', () => {
    const routes = extractFromFixtureFile('controller.ts');
    assert.equal(routes.length, 1);
    const route = routes[0];
    assert.equal(route.handlerSymbol, 'userController.list');
    assert.equal(route.path, '/users');
  });

  it('resolves nested static mount prefixes', () => {
    const routes = extractFromFixtureFile('nested.ts');
    assert.equal(routes.length, 1);
    const route = findRoute(routes, 'GET', '/api/users/:id');
    assert.ok(route, `expected GET /api/users/:id, got ${routes[0]?.path}`);
    assert.equal(route.mountPrefix, '/api/users');
  });

  it('does not treat map.get or collection.get as HTTP routes', () => {
    const routes = extractFromFixtureFile('false-positives.ts');
    assert.equal(routes.length, 0);
  });

  it('marks unresolved dynamic mount prefix as low confidence', () => {
    const routes = extractFromFixtureFile('unresolved-prefix.ts');
    assert.equal(routes.length, 1);
    const route = routes[0];
    assert.equal(route.path, '/users');
    assert.equal(route.confidence, 'low');
    assert.equal(route.unresolvedMount, true);
  });

  it('tracks source line numbers', () => {
    const routes = extractFromFixtureFile('basic.ts');
    for (const route of routes) {
      assert.ok(route.line > 0);
      assert.ok(route.sourceFile.endsWith('basic.ts'));
    }
  });

  it('generates deterministic route IDs', () => {
    const a = extractFromFixtureFile('basic.ts');
    const b = extractFromFixtureFile('basic.ts');
    assert.deepEqual(
      a.map((r) => r.id),
      b.map((r) => r.id),
    );
  });
});

describe('RouteAnalyzer workspace integration', () => {
  it('extracts routes from express-routes fixture via WorkspaceAnalysisService', () => {
    const routes = routesFromFixture('express-routes');
    assert.ok(routes.length >= 8);
    assert.ok(findRoute(routes, 'GET', '/api/users'));
    assert.ok(findRoute(routes, 'GET', '/api/users/:id'));
  });

  it('continues analysis when one file has no routes', () => {
    const result = analyzeFixture('express-routes');
    assert.ok(result.files.length >= 8);
    assert.equal(result.routeExtraction.errors.length, 0);
  });
});

describe('RouteGraphBuilder', () => {
  it('creates Route nodes and handles edges', () => {
    const result = analyzeFixture('express-routes');
    const builder = new RouteGraphBuilder();
    const patch = builder.build(result.routes, result.files);

    assert.ok(patch.upsertNodes.some((n) => n.kind === 'Route'));
    assert.ok(patch.upsertEdges.some((e) => e.kind === 'handles'));
    assert.ok(patch.upsertEdges.some((e) => e.kind === 'servedBy'));
  });

  it('merges route nodes into workspace graph snapshot', () => {
    const result = analyzeFixture('express-routes');
    const routeNodes = result.graph.nodes.filter((n) => n.kind === 'Route');
    assert.ok(routeNodes.length >= 8);
  });
});

describe('RouteAnalyzer isolation', () => {
  it('does not require webview or ExplorerService', () => {
    const analyzer = new RouteAnalyzer();
    const result = analyzeFixture('basic-imports');
    const extraction = analyzer.analyze(result.files);
    assert.equal(extraction.routes.length, 0);
    assert.equal(extraction.errors.length, 0);
  });
});
