/** Hardcoded Phase-1 ignore rules. Filter UI arrives in Phase 3. */

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.git',
  'out',
  '.turbo',
  '.vercel',
  '.cache',
  'storybook-static',
]);

const TEST_FILE_RE =
  /(\.|\/|\\)(test|spec|tests|__tests__|__mocks__)(\.|\/|\\|$)|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/i;

const GENERATED_FILE_RE =
  /\.d\.ts$|\.gen\.[jt]sx?$|\.generated\.[jt]sx?$/i;

export function shouldIgnoreDirectory(dirName: string): boolean {
  return IGNORED_DIR_NAMES.has(dirName);
}

export function shouldIgnoreFile(relativePath: string): boolean {
  if (TEST_FILE_RE.test(relativePath)) {
    return true;
  }
  if (GENERATED_FILE_RE.test(relativePath)) {
    return true;
  }
  return false;
}

export function isSourceFile(fileName: string): boolean {
  return /\.(tsx?|jsx?|mts|cts)$/i.test(fileName);
}
