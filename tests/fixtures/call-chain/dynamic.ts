const service = {
  run(): void {
    return;
  },
};

export function dynamicHandler(): void {
  const methodName = 'run';
  service[methodName]();
}
