export function fnA(): void {
  fnB();
}

export function fnB(): void {
  fnC();
}

export function fnC(): void {
  fnA();
}
