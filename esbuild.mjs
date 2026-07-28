import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

mkdirSync(join(__dirname, 'out'), { recursive: true });
mkdirSync(join(__dirname, 'out', 'webview'), { recursive: true });
mkdirSync(join(__dirname, 'out', 'parser', 'workers'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: [join(__dirname, 'src', 'extension', 'activate.ts')],
  bundle: true,
  outfile: join(__dirname, 'out', 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const workerBuild = {
  entryPoints: [join(__dirname, 'src', 'parser', 'workers', 'parseWorker.ts')],
  bundle: true,
  outfile: join(__dirname, 'out', 'parser', 'workers', 'parseWorker.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuild = {
  entryPoints: [join(__dirname, 'src', 'webview', 'index.tsx')],
  bundle: true,
  outfile: join(__dirname, 'out', 'webview', 'main.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
  loader: {
    '.css': 'css',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

async function buildAll() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionBuild),
      esbuild.context(workerBuild),
      esbuild.context(webviewBuild),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(workerBuild),
      esbuild.build(webviewBuild),
    ]);
  }

  const cssSrc = join(__dirname, 'src', 'webview', 'styles.css');
  if (existsSync(cssSrc)) {
    copyFileSync(cssSrc, join(__dirname, 'out', 'webview', 'styles.css'));
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
