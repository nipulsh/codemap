import { z } from 'zod';

export const RuntimeTraceSummarySchema = z.object({
  traceId: z.string(),
  routeId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['active', 'completed', 'error']),
  attributes: z
    .object({
      httpMethod: z.string().optional(),
      routePattern: z.string().optional(),
      statusCode: z.number().optional(),
    })
    .optional(),
});

export type RuntimeTraceSummaryWire = z.infer<typeof RuntimeTraceSummarySchema>;

export function formatRuntimeTraceSummary(summary: RuntimeTraceSummaryWire): string {
  const time = new Date(summary.startedAt).toLocaleTimeString();
  const duration =
    summary.durationMs !== undefined ? `${summary.durationMs}ms` : '—';
  const status = summary.attributes?.statusCode ?? (summary.status === 'error' ? 'ERR' : '—');
  const method = summary.attributes?.httpMethod ?? '';
  const path = summary.attributes?.routePattern ?? summary.routeId ?? summary.traceId;
  return `${time}  ${duration}  ${status}  ${method} ${path}`.trim();
}

export function sortRuntimeTraceSummaries(
  summaries: RuntimeTraceSummaryWire[],
): RuntimeTraceSummaryWire[] {
  return [...summaries].sort((a, b) => {
    const timeCmp = b.startedAt - a.startedAt;
    return timeCmp !== 0 ? timeCmp : a.traceId.localeCompare(b.traceId);
  });
}

export function summariesForRoute(
  summaries: RuntimeTraceSummaryWire[],
  routeId: string,
): RuntimeTraceSummaryWire[] {
  return sortRuntimeTraceSummaries(
    summaries.filter((s) => s.routeId === routeId),
  );
}
