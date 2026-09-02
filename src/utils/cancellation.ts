/**
 * Minimal cancellation helpers built on the standard AbortSignal.
 * No custom cancellation framework — callers pass an AbortSignal and long-running
 * pipelines check it at safe checkpoints.
 */

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

export function isAnalysisCancelledError(
  err: unknown,
): err is AnalysisCancelledError {
  return (
    err instanceof AnalysisCancelledError ||
    (err instanceof Error && err.name === 'AnalysisCancelledError')
  );
}

/** Throw AnalysisCancelledError when the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AnalysisCancelledError();
  }
}

/** Give the event loop a turn so timers, I/O, and cancellation callbacks can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
