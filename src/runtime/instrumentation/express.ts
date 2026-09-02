import type { Express, NextFunction, Request, Response } from 'express';
import type { RouteDefinition } from '../../routes/types';
import {
  newSpanId,
  newTraceId,
  runWithTraceContext,
  type TraceContext,
} from './context';
import type { TraceRequestAttributes } from '../types';
import type {
  ExpressInstrumentationOptions,
  InstrumentationHandle,
  RouteResolutionContext,
  RouteResolver,
} from './types';

/** Combine Express mount prefix and route pattern into a normalized template path. */
export function resolveExpressRoutePattern(req: Request): string | undefined {
  if (!req.route) {
    return undefined;
  }

  const base = req.baseUrl ?? '';
  const routePath = req.route.path;

  if (routePath === '/') {
    return base || '/';
  }

  const combined = `${base}${routePath}`.replace(/\/+/g, '/');
  return combined || '/';
}

function normalizeRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()}:${path.replace(/\/+$/, '') || '/'}`;
}

/**
 * Build a resolver from static RouteDefinition entries.
 * Matches normalized HTTP method + Express route template (not raw request URLs).
 */
export function createRouteResolverFromDefinitions(
  routes: Array<Pick<RouteDefinition, 'id' | 'method' | 'path'>>,
): RouteResolver {
  const index = new Map<string, string>();
  for (const route of routes) {
    index.set(normalizeRouteKey(route.method, route.path), route.id);
  }

  return (context: RouteResolutionContext) => {
    if (!context.routePattern) {
      return undefined;
    }
    return index.get(normalizeRouteKey(context.method, context.routePattern));
  };
}

function buildRequestAttributes(
  req: Request,
  res: Response,
  includeRequestMetadata: boolean,
): TraceRequestAttributes | undefined {
  if (!includeRequestMetadata) {
    return undefined;
  }

  return {
    httpMethod: req.method,
    routePattern: resolveExpressRoutePattern(req),
    statusCode: res.statusCode,
  };
}

export function instrumentExpress(
  app: Express,
  options: ExpressInstrumentationOptions,
): InstrumentationHandle {
  let active = true;

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!active) {
      next();
      return;
    }

    const traceId = newTraceId();
    const startedAt = Date.now();
    const handlerSpanId = newSpanId();

    options.collector.ingest({
      type: 'trace-started',
      traceId,
      startedAt,
    });

    options.collector.ingest({
      type: 'span-started',
      traceId,
      spanId: handlerSpanId,
      functionName: 'express.handler',
      startedAt,
    });

    const context: TraceContext = {
      traceId,
      currentSpanId: handlerSpanId,
      collector: options.collector,
    };

    let finalized = false;

    const finalize = (spanStatus: 'completed' | 'error') => {
      if (finalized) {
        return;
      }
      finalized = true;

      const completedAt = Date.now();
      const routePattern = resolveExpressRoutePattern(req);
      const routeId = options.routeResolver?.({
        method: req.method,
        routePattern,
        baseUrl: req.baseUrl,
      });

      if (routeId) {
        options.collector.ingest({
          type: 'trace-started',
          traceId,
          routeId,
          startedAt,
        });
      }

      if (spanStatus === 'completed') {
        options.collector.ingest({
          type: 'span-completed',
          traceId,
          spanId: handlerSpanId,
          completedAt,
        });
      } else {
        options.collector.ingest({
          type: 'span-errored',
          traceId,
          spanId: handlerSpanId,
          completedAt,
          error: { message: 'Request closed before completion' },
        });
      }

      options.collector.ingest({
        type: 'trace-completed',
        traceId,
        completedAt,
        attributes: buildRequestAttributes(
          req,
          res,
          options.includeRequestMetadata ?? false,
        ),
      });
    };

    res.on('finish', () => finalize('completed'));
    res.on('close', () => {
      if (!res.writableFinished) {
        finalize('error');
      }
    });

    runWithTraceContext(context, () => {
      try {
        next();
      } catch (error) {
        const completedAt = Date.now();
        options.collector.ingest({
          type: 'span-errored',
          traceId,
          spanId: handlerSpanId,
          completedAt,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { message: String(error) },
        });
        options.collector.ingest({
          type: 'trace-completed',
          traceId,
          completedAt,
        });
        finalized = true;
        throw error;
      }
    });
  };

  app.use(middleware);

  return {
    dispose() {
      active = false;
    },
  };
}

export const EXPRESS_INSTRUMENTATION_LIMITATIONS = [
  'Express instrumentation is opt-in and must be enabled via instrumentExpress().',
  'Route ID resolution requires a supplied route catalog; dynamic mounts may remain unresolved.',
  'No request headers, bodies, cookies, or authorization values are collected by default.',
  'Compatible with Express 4.x middleware and router APIs; private internals are not used.',
] as const;
