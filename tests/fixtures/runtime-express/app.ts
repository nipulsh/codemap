import express, { type Express } from 'express';
import type { TraceCollector } from '../../../src/runtime/TraceCollector.ts';
import {
  createRouteResolverFromDefinitions,
  instrumentExpress,
  type ExpressInstrumentationOptions,
} from '../../../src/runtime/instrumentation/instrumentation.ts';
import type { Request, Response, NextFunction } from 'express';
import { getUserController, errorController } from './controller.ts';

export const RUNTIME_EXPRESS_ROUTE_ID = 'route:get:/users/:id';

export interface RuntimeExpressAppOptions {
  collector: TraceCollector;
  includeRequestMetadata?: boolean;
  resolveRoutes?: boolean;
}

export function createRuntimeExpressApp(
  options: RuntimeExpressAppOptions,
): Express {
  const app = express();

  const instrumentationOptions: ExpressInstrumentationOptions = {
    collector: options.collector,
    includeRequestMetadata: options.includeRequestMetadata ?? false,
    routeResolver: options.resolveRoutes
      ? createRouteResolverFromDefinitions([
          {
            id: RUNTIME_EXPRESS_ROUTE_ID,
            method: 'GET',
            path: '/users/:id',
          },
        ])
      : undefined,
  };

  instrumentExpress(app, instrumentationOptions);

  app.get('/users/:id', getUserController);
  app.get('/error', errorController);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}
