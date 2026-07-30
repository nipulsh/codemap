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

  it('validates folder:expand from webview', () => {
    const parsed = WebviewToExtensionSchema.parse({
      type: 'folder:expand',
      payload: { path: '/proj/src' },
    });
    assert.equal(parsed.type, 'folder:expand');
  });

  it('validates graph:patch with hierarchy edges', () => {
    const msg = {
      type: 'graph:patch' as const,
      payload: {
        upsertNodes: [
          {
            id: 'folder:x',
            kind: 'Folder' as const,
            label: 'src',
            metadata: {},
          },
        ],
        removeNodeIds: [],
        upsertEdges: [
          {
            id: 'hierarchy:a->b',
            kind: 'hierarchy' as const,
            source: 'a',
            target: 'b',
          },
        ],
        removeEdgeIds: [],
      },
    };
    const parsed = ExtensionToWebviewSchema.parse(msg);
    assert.equal(parsed.type, 'graph:patch');
  });

  it('rejects unknown message types', () => {
    assert.throws(() =>
      ExtensionToWebviewSchema.parse({ type: 'nope', payload: {} }),
    );
  });
});
