import { z } from 'zod';
import {
  FilterStateSchema,
  GraphPatchSchema,
  GraphSnapshotSchema,
  SearchResultSchema,
} from './graph';
import { RouteTraceDataSchema } from './routeTrace';
import { TraceOverlaySchema } from './traceOverlay';
import { RuntimeTraceSummarySchema } from './runtimeTrace';

export const ExtensionToWebviewSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('graph:full'),
    payload: GraphSnapshotSchema,
  }),
  z.object({
    type: z.literal('graph:patch'),
    payload: GraphPatchSchema,
  }),
  z.object({
    type: z.literal('search:results'),
    payload: z.array(SearchResultSchema),
  }),
  z.object({
    type: z.literal('progress'),
    payload: z.object({
      message: z.string(),
      percent: z.number().min(0).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('error'),
    payload: z.object({
      message: z.string(),
      scope: z.string(),
    }),
  }),
  z.object({
    type: z.literal('routeTrace:data'),
    payload: RouteTraceDataSchema,
  }),
  z.object({
    type: z.literal('runtimeTrace:overlay'),
    payload: TraceOverlaySchema,
  }),
  z.object({
    type: z.literal('runtimeTrace:list'),
    payload: z.object({
      runtimeTraces: z.array(RuntimeTraceSummarySchema),
    }),
  }),
]);
export type ExtensionToWebview = z.infer<typeof ExtensionToWebviewSchema>;

export const WebviewToExtensionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('node:open'),
    payload: z.object({
      filePath: z.string(),
      line: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal('node:select'),
    payload: z.object({
      nodeId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('search:query'),
    payload: z.object({
      query: z.string(),
    }),
  }),
  z.object({
    type: z.literal('filter:update'),
    payload: FilterStateSchema,
  }),
  z.object({
    type: z.literal('folder:expand'),
    payload: z.object({
      path: z.string(),
    }),
  }),
  z.object({
    type: z.literal('folder:collapse'),
    payload: z.object({
      path: z.string(),
    }),
  }),
  z.object({
    type: z.literal('file:expand'),
    payload: z.object({
      path: z.string(),
    }),
  }),
  z.object({
    type: z.literal('file:collapse'),
    payload: z.object({
      path: z.string(),
    }),
  }),
  z.object({
    type: z.literal('function:expand'),
    payload: z.object({
      nodeId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('function:collapse'),
    payload: z.object({
      nodeId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('graph:refresh'),
  }),
  z.object({
    type: z.literal('ready'),
  }),
  z.object({
    type: z.literal('routeTrace:request'),
  }),
  z.object({
    type: z.literal('runtimeTrace:refresh'),
  }),
  z.object({
    type: z.literal('runtimeTrace:select'),
    payload: z.object({
      routeId: z.string(),
      traceId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('viewMode:set'),
    payload: z.object({
      mode: z.enum(['architecture', 'route-trace']),
    }),
  }),
]);
export type WebviewToExtension = z.infer<typeof WebviewToExtensionSchema>;

export function parseExtensionToWebview(data: unknown): ExtensionToWebview {
  return ExtensionToWebviewSchema.parse(data);
}

export function parseWebviewToExtension(data: unknown): WebviewToExtension {
  return WebviewToExtensionSchema.parse(data);
}

export function safeParseExtensionToWebview(data: unknown) {
  return ExtensionToWebviewSchema.safeParse(data);
}

export function safeParseWebviewToExtension(data: unknown) {
  return WebviewToExtensionSchema.safeParse(data);
}
