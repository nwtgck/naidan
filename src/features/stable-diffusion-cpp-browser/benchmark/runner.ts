import { requestSchema, workerResultSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { Progress } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import { sanitizeImageLog } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { createBenchmarkMeasurements } from './measurements';
import { MAX_BENCHMARK_IMAGE_BYTES } from './types';
import type { BenchmarkPlan, BenchmarkSnapshot, BenchmarkRun } from './types';

export type BenchmarkRunner = ReturnType<typeof createBenchmarkRunner>;
/** One queue, one physical worker at a time. No retry, model download, precision
 * downgrade or cold run disguised as warm after a failure. */
export function createBenchmarkRunner({ createClient, now, date, observeVisibility, publish }: {
  createClient: () => ImageClient, now: () => number, date: () => string,
  observeVisibility: ({ changed }: { changed: ({ hidden }: { hidden: boolean }) => void }) => () => void,
  publish: ({ runs, current, progress }: { runs: BenchmarkRun[], current: string | undefined, progress: Progress | undefined }) => void,
}) {
  let active: AbortController | undefined, client: ImageClient | undefined, snapshot: BenchmarkSnapshot | undefined;
  let current: string | undefined, progress: Progress | undefined, dead = false;
  let liveLog: ReturnType<typeof createBenchmarkMeasurements> | undefined;
  function report(): void {
    if (!dead && snapshot) try {
      publish({ runs: [...snapshot.runs], current, progress });
    } catch { /* UI observation must not alter inference */ }
  }
  function updateLive(): void {
    const run = snapshot?.runs.find(r => r.record.id === current);
    if (run && liveLog) {
      const data = liveLog.snapshot(); run.diagnostics = data.text; run.record.metrics = data.metrics;
    }
  }
  async function delay({ milliseconds, signal }: { milliseconds: number, signal: AbortSignal }): Promise<void> {
    if (!milliseconds) {
      signal.throwIfAborted(); return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort); resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  function stop(): void {
    active?.abort(new DOMException('Benchmark stopped', 'AbortError'));
    client?.dispose(); client = undefined;
  }
  async function start({ plan }: { plan: BenchmarkPlan }): Promise<void> {
    if (dead || active) throw new Error('Benchmark is disposed or already running');
    const control = new AbortController(); active = control;
    const batch: BenchmarkSnapshot = {
      plan,
      state: 'running',
      runs: plan.models.flatMap((_model, modelIndex) => Array.from({ length: plan.protocol.repeats }, (_, runIndex): BenchmarkRun => ({
        record: {
          id: `m${String(modelIndex + 1).padStart(3, '0')}-r${String(runIndex + 1).padStart(3, '0')}`,
          modelIndex,
          runIndex,
          plannedKind: plan.protocol.mode === 'cold-warm' && runIndex > 0 ? 'warm' : 'cold',
          status: 'queued',
          metrics: { diagnosticsReceived: 0, invalidDiagnostics: 0, omittedDiagnostics: 0, steps: [] },
          image: { status: 'no-output', bytes: 0 },
          previewFrames: 0,
          hiddenObserved: false,
          visibilityChanges: 0,
        },
        diagnostics: '',
        png: undefined,
      }))),
    };
    snapshot = batch;
    let imageBytes = 0;
    try {
      report();
      for (let mi = 0; mi < plan.models.length; mi++) {
        const model = plan.models[mi]!; let previousSucceeded = true;
        try {
          for (const run of batch.runs.filter(r => r.record.modelIndex === mi)) {
            if (control.signal.aborted) break;
            if (!previousSucceeded && plan.protocol.mode === 'cold-warm') {
              run.record.status = 'skipped'; run.record.skipReason = 'preceding-run-failed'; report(); continue;
            }
            await delay({ milliseconds: plan.protocol.cooldownSeconds * 1000, signal: control.signal });
            const request = requestSchema.parse(model.request); // detached even from the immutable plan
            const operation = new AbortController();
            const abort = () => operation.abort(control.signal.reason);
            control.signal.addEventListener('abort', abort, { once: true });
            let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
            let stopVisibility = () => {};
            const log = createBenchmarkMeasurements(); liveLog = log; current = run.record.id; progress = undefined;
            run.record.status = 'running'; run.record.startedAt = date();
            const started = now();
            try {
              let previousHidden: boolean | undefined;
              stopVisibility = observeVisibility({
                changed({ hidden }) {
                // The observer reports the initial state before subscribing.
                // It matters for hiddenObserved, but is not a visibility change.
                  if (previousHidden !== undefined && previousHidden !== hidden) run.record.visibilityChanges++;
                  previousHidden = hidden; run.record.hiddenObserved ||= hidden;
                },
              });
              client ??= createClient();
              if (plan.protocol.timeoutSeconds) timer = setTimeout(() => {
                timedOut = true; operation.abort(new DOMException('Benchmark run timed out', 'TimeoutError'));
                client?.dispose(); client = undefined;
              }, plan.protocol.timeoutSeconds * 1000);
              const stopped = Promise.withResolvers<never>();
              void stopped.promise.catch(() => undefined);
              const abortOperation = () => stopped.reject(operation.signal.reason);
              operation.signal.addEventListener('abort', abortOperation, { once: true });
              try {
                report();
                // UI observers can synchronously request Stop, including on first progress.
                if (control.signal.aborted) abort(); operation.signal.throwIfAborted();
                const result = workerResultSchema.parse(await Promise.race([client.generate({
                  request,
                  signal: operation.signal,
                  onDiagnostic({ diagnostic }) {
                    if (liveLog === log && current === run.record.id) log.append({ diagnostic });
                  },
                  onProgress({ event }) {
                    if (liveLog !== log || operation.signal.aborted || current !== run.record.id) return; progress = event; updateLive(); report();
                  },
                  onPreview() {
                    if (liveLog === log && !operation.signal.aborted && current === run.record.id) run.record.previewFrames++;
                  },
                }), stopped.promise]));
                operation.signal.throwIfAborted();
                if ('cancelled' in result) {
                  run.record.status = 'cancelled'; previousSucceeded = false;
                } else {
                  if (result.width !== request.parameters.width || result.height !== request.parameters.height) throw new Error('Benchmark result dimensions differ from request');
                  run.record.status = 'succeeded'; run.record.modelVersion = result.modelVersion; run.record.uniformOutput = result.uniformOutput;
                  run.record.image = { status: 'not-requested', bytes: result.png.size };
                  if (plan.protocol.keepImages) {
                    if (imageBytes + result.png.size <= MAX_BENCHMARK_IMAGE_BYTES) {
                      imageBytes += result.png.size; run.png = result.png; run.record.image.status = 'retained';
                    } else run.record.image.status = 'budget-exceeded';
                  }
                }
              } finally {
                operation.signal.removeEventListener('abort', abortOperation);
              }
            } catch (error) {
              previousSucceeded = false;
              run.record.status = control.signal.aborted ? 'cancelled' : 'failed';
              run.record.error = timedOut ? 'Benchmark run timed out' : sanitizeImageLog({ message: error instanceof Error ? error.message : String(error), secrets: [request.parameters.prompt, request.parameters.negativePrompt, request.parameters.modelArguments] });
            } finally {
              clearTimeout(timer); control.signal.removeEventListener('abort', abort);
              try {
                stopVisibility();
              } catch { /* optional observation cleanup */ }
              run.record.endedAt = date(); run.record.elapsedMs = Math.max(0, now() - started); updateLive(); liveLog = undefined;
              if (plan.protocol.mode === 'fresh-each' || run.record.status !== 'succeeded') {
                client?.dispose(); client = undefined;
              }
              current = undefined; progress = undefined; report();
            }
          }
        } finally {
          client?.dispose(); client = undefined;
        } // never carry weights into another model
      }
    } catch (error) {
      if (!control.signal.aborted) throw error;
    } finally {
      client?.dispose(); client = undefined;
      for (const run of batch.runs) switch (run.record.status) {
      case 'queued': run.record.status = 'skipped'; run.record.skipReason = control.signal.aborted ? 'batch-cancelled' : 'batch-interrupted'; break;
      case 'running': case 'succeeded': case 'failed': case 'cancelled': case 'skipped': break;
      default: { const exhaustive: never = run.record.status; void exhaustive; }
      }
      batch.state = control.signal.aborted ? 'cancelled' : 'finished'; active = undefined; current = undefined; progress = undefined; report();
    }
  }
  return {
    start,
    stop,
    snapshot(): BenchmarkSnapshot | undefined {
      updateLive(); return snapshot;
    },
    clear(): void {
      if (!active) {
        snapshot = undefined; current = undefined; progress = undefined;
      }
    },
    dispose(): void {
      dead = true; stop(); snapshot = undefined;
    },
  };
}
export const TEST_ONLY = {
};
