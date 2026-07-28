import { relative, sep, normalize, isAbsolute, join } from 'node:path';

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function relativePosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}

export function normalizePath(p: string): string {
  return toPosix(normalize(p));
}

export function joinPosix(...parts: string[]): string {
  return toPosix(join(...parts));
}

export function ensureAbsolute(root: string, maybeRelative: string): string {
  if (isAbsolute(maybeRelative)) {
    return normalizePath(maybeRelative);
  }
  return normalizePath(join(root, maybeRelative));
}
