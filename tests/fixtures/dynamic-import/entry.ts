export async function load(): Promise<string> {
  const mod = await import('./lazy');
  return mod.lazyHelper();
}
