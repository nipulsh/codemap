import { add } from './utils';

export function total(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0);
}
