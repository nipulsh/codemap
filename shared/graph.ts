import { z } from 'zod';

export const NodeKindSchema = z.enum(['Folder', 'File', 'Function', 'Component']);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const EdgeKindSchema = z.enum([
  'imports',
  'exports',
  'calls',
  'contains',
  'dynamicImport',
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  kind: NodeKindSchema,
  label: z.string(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  kind: EdgeKindSchema,
  source: z.string(),
  target: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSnapshotSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  generatedAt: z.number(),
  workspaceRoot: z.string().optional(),
});
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export const GraphPatchSchema = z.object({
  upsertNodes: z.array(GraphNodeSchema).default([]),
  removeNodeIds: z.array(z.string()).default([]),
  upsertEdges: z.array(GraphEdgeSchema).default([]),
  removeEdgeIds: z.array(z.string()).default([]),
});
export type GraphPatch = z.infer<typeof GraphPatchSchema>;

export const SearchResultSchema = z.object({
  id: z.string(),
  kind: NodeKindSchema,
  label: z.string(),
  filePath: z.string().optional(),
  line: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const FilterStateSchema = z.object({
  hideNodeModules: z.boolean().default(true),
  hideNext: z.boolean().default(true),
  hideDist: z.boolean().default(true),
  hideBuild: z.boolean().default(true),
  hideCoverage: z.boolean().default(true),
  hideTestFiles: z.boolean().default(true),
  hideGenerated: z.boolean().default(true),
});
export type FilterState = z.infer<typeof FilterStateSchema>;
