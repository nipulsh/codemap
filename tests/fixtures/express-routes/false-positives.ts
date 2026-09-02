const map = new Map<string, string>();
const collection = { get(_key: string): string { return ''; } };

map.get('key');
collection.get('x');

function foo() {
  return {
    get(_path: string) {
      return;
    },
  };
}

foo().get('/not-an-http-route');
