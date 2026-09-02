import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function contentHash(filePath: string): string {
  return hashContent(readFileSync(filePath));
}

export function fileMtimeMs(filePath: string): number {
  return statSync(filePath).mtimeMs;
}
