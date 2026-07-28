import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function contentHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function fileMtimeMs(filePath: string): number {
  return statSync(filePath).mtimeMs;
}
