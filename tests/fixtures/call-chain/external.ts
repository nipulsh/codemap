declare const bcrypt: { compare(a: string, b: string): void };

export function externalHandler(): void {
  bcrypt.compare('a', 'b');
}
