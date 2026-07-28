import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionToWebviewSchema,
  WebviewToExtensionSchema,
} from '../shared/messages.ts';

describe('message protocol', () => {
  it('validates graph:full messages', () => {
    const msg = {
      type: 'graph:full' as const,
      payload: {
        nodes: [
          {
            id: 'file:a',
            kind: 'File' as const,
            label: 'a.ts',
            metadata: {},
          },
        ],
        edges: [],
        generatedAt: Date.now(),
      },
    };
    const parsed = ExtensionToWebviewSchema.parse(msg);
    assert.equal(parsed.type, 'graph:full');
  });

  it('validates graph:refresh from webview', () => {
    const parsed = WebviewToExtensionSchema.parse({ type: 'graph:refresh' });
    assert.equal(parsed.type, 'graph:refresh');
  });

  it('rejects unknown message types', () => {
    assert.throws(() =>
      ExtensionToWebviewSchema.parse({ type: 'nope', payload: {} }),
    );
  });
});
