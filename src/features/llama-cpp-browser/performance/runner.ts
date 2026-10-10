import { nanoid } from 'nanoid';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { type GenerateInput, type RuntimeOptions, errorCode } from '@/features/llama-cpp-browser/types';
import { planSchema, type PerformanceSnapshot, type PerformanceStep, type PerformanceTrial } from './types';

/** No chat store, alternate inference loop, rendering or archive work here. */
export function createPerformanceRunner({ service, now, date, hidden, waitUntilVisible, publish }: {
  service: Pick<LlamaCppBrowserService, 'runPerformanceOperation' | 'listModels'>,
  now: () => number, date: () => string, hidden: () => boolean,
  waitUntilVisible: ({ signal }: { signal: AbortSignal }) => Promise<void>,
  publish: ({ snapshot, current }: { snapshot: PerformanceSnapshot, current: PerformanceTrial | undefined }) => void,
}) {
  let controller: AbortController | undefined;
  let snapshot: PerformanceSnapshot | undefined;
  let current: PerformanceTrial | undefined;
  let runStarted: number | undefined;
  const notify = () => {
    if (snapshot) publish({ snapshot, current });
  };
  const skip = ({ step, options, error }: { step: PerformanceStep, options: RuntimeOptions, error: string }): void => {
    snapshot?.trials.push({
      id: nanoid(),
      stepId: step.id,
      modelIndex: step.modelIndex,
      status: 'skipped',
      startedAt: date(),
      input: [],
      options,
      partialText: '',
      partialReasoning: '',
      receivedEvents: 0,
      hiddenObserved: hidden(),
      error,
      warnings: [],
      exclusion: ['failed'],
    });
  };
  return {
    snapshot: () => snapshot,
    stop(): void {
      controller?.abort();
    },
    visibilityChanged(): void {
      if (current && hidden()) current.hiddenObserved = true;
      if (controller && runStarted !== undefined && snapshot?.execution) {
        const execution = snapshot.execution;
        if (execution.visibility.length < 256) execution.visibility.push({ atMs: Math.max(0, now() - runStarted), hidden: hidden() });
        else execution.droppedVisibilityEvents++;
      }
      notify();
    },
    async start({ plan: inputPlan, environment }: Pick<PerformanceSnapshot, 'plan' | 'environment'>): Promise<void> {
      if (controller) throw new Error('Measurement already running');
      const plan = planSchema.parse(inputPlan);
      const control = new AbortController(); controller = control;
      runStarted = now();
      const started = runStarted;
      const execution: NonNullable<PerformanceSnapshot['execution']> = {
        startedAt: date(),
        intervals: [],
        visibility: [{ atMs: 0, hidden: hidden() }],
        droppedVisibilityEvents: 0,
      };
      const elapsed = () => Math.max(0, now() - started);
      // Orchestration intervals are not GPU timings. All clocks here are outside
      // token callbacks and keep hidden-page waiting separate from native work.
      const interval = ({ kind, modelIndex, stepId }: { kind: typeof execution.intervals[number]['kind'], modelIndex: number, stepId?: string }) => {
        const start = elapsed(), hiddenAtStart = hidden();
        return ({ outcome }: { outcome: typeof execution.intervals[number]['outcome'] }) => {
          execution.intervals.push({ kind, modelIndex, stepId, startedMs: start, elapsedMs: Math.max(0, elapsed() - start), hiddenAtStart, outcome });
        };
      };
      const visible = async ({ modelIndex, stepId }: { modelIndex: number, stepId?: string }) => {
        const finish = interval({ kind: 'visibility-wait', modelIndex, stepId });
        let outcome: typeof execution.intervals[number]['outcome'] = 'completed';
        try {
          await waitUntilVisible({ signal: control.signal });
        } catch (error) {
          outcome = control.signal.aborted ? 'cancelled' : 'failed'; throw error;
        } finally {
          finish({ outcome });
        }
      };
      snapshot = { plan, environment, status: 'running', trials: [], modelErrors: [], execution };
      const activeSnapshot = snapshot;
      notify();
      try {
        for (const [modelIndex, model] of plan.models.entries()) {
          if (control.signal.aborted) break;
          const steps = plan.steps.filter(step => step.modelIndex === modelIndex);
          try {
            await visible({ modelIndex });
            const inventory = interval({ kind: 'model-inventory', modelIndex });
            const stored = await service.listModels({ signal: control.signal }).then(value => {
              inventory({ outcome: 'completed' }); return value;
            }, error => {
              inventory({ outcome: control.signal.aborted ? 'cancelled' : 'failed' }); throw error;
            });
            const matching = stored.filter(entry => entry.name === model.name);
            if (matching.length !== 1 || matching[0]?.id !== model.id || matching[0]?.size !== model.size || matching[0]?.importedAt !== model.importedAt) throw new Error('Selected model inventory changed');
            const acquired = interval({ kind: 'model-acquire', modelIndex });
            let entered = false;
            let release: ReturnType<typeof interval> | undefined;
            let operationOutcome: typeof execution.intervals[number]['outcome'] = 'completed';
            try {
              await service.runPerformanceOperation({
                options: plan.options,
                signal: control.signal,
                operation: async ({ scope }) => {
                  entered = true; acquired({ outcome: 'completed' });
                  // Service cancellation must also interrupt visibility waits, not
                  // only a currently running native call. Detach before the service
                  // aborts its scope during ordinary end-of-model cleanup.
                  const abortOperation = () => control.abort();
                  scope.signal.addEventListener('abort', abortOperation, { once: true });
                  if (scope.signal.aborted) abortOperation();
                  try {
                    for (const step of steps) {
                      if (control.signal.aborted) break;
                      await visible({ modelIndex, stepId: step.id });
                      control.signal.throwIfAborted();
                      const parent = step.dependsOn === undefined ? undefined : activeSnapshot.trials.find(trial => trial.stepId === step.dependsOn);
                      if (step.dependsOn !== undefined && (parent?.status !== 'succeeded' || !parent.output || parent.output.toolCalls.length || (!parent.output.content && !parent.output.reasoningContent))) {
                        skip({ step, options: scope.options, error: 'Continuation preparation did not produce a usable assistant response' }); notify(); continue;
                      }
                      const messages: PerformanceTrial['input'] = parent?.output
                        ? [...parent.input, { role: 'assistant', content: parent.output.content, reasoning_content: parent.output.reasoningContent }, { role: 'user', content: step.prompt }]
                        : [{ role: 'user', content: step.prompt }];
                      const trial: PerformanceTrial = {
                        id: nanoid(),
                        stepId: step.id,
                        modelIndex,
                        status: 'running',
                        startedAt: date(),
                        startedMs: elapsed(),
                        input: messages,
                        options: { ...scope.options },
                        partialText: '',
                        partialReasoning: '',
                        receivedEvents: 0,
                        hiddenObserved: hidden() || Boolean(parent?.hiddenObserved),
                        warnings: [],
                        exclusion: [],
                      };
                      if (parent?.output?.finishReason !== undefined && parent.output.finishReason !== 'stop') trial.warnings.push('incomplete-parent');
                      activeSnapshot.trials.push(trial); current = trial; notify();
                      const started = now(); let lastDelivery: number | undefined; let accepting = true; let timedOut = false;
                      const local = new AbortController();
                      const abort = () => local.abort();
                      const sources = [...new Set([control.signal, scope.signal])];
                      for (const signal of sources) {
                        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                      }
                      const timer = setTimeout(() => {
                        timedOut = true; local.abort();
                      }, plan.settings.timeoutMs);
                      const observation = (() => {
                        switch (step.scenario) {
                        case 'placement': return 'placement' as const;
                        case 'initial': case 'short': case 'long': case 'continuation': return undefined;
                        default: { const exhaustive: never = step.scenario; throw new Error(String(exhaustive)); }
                        }
                      })();
                      const input: Omit<GenerateInput, 'options'> = {
                        model: model.name,
                        messages,
                        debug: 'off',
                        temperature: 0,
                        topP: 1,
                        maxTokens: step.maxTokens,
                        presencePenalty: 0,
                        frequencyPenalty: 0,
                        stop: [],
                      };
                      try {
                        trial.output = await scope.generate({
                          input,
                          sequence: step.sequence,
                          observation,
                          signal: local.signal,
                          onProgress: ({ progress }) => {
                            if (!accepting) return;
                            trial.lastProgress = { ...progress };
                            trial.lastProgressMs = Math.max(0, now() - started);
                          },
                          onMemoryDiagnostics: ({ memory }) => {
                            if (accepting) trial.memoryDiagnostics = memory;
                          },
                          onSummary: ({ diagnostic }) => {
                            if (accepting) trial.summary = diagnostic;
                          },
                          onEvent: ({ event }) => {
                            if (!accepting) return;
                            const elapsed = Math.max(0, now() - started);
                            trial.receivedEvents++;
                            switch (event.type) {
                            case 'text': case 'reasoning': {
                              if (!event.text.length) return;
                              trial.firstReceivedMs ??= elapsed;
                              if (lastDelivery !== undefined) trial.maximumDeliveryGapMs = Math.max(trial.maximumDeliveryGapMs ?? 0, elapsed - lastDelivery);
                              lastDelivery = elapsed;
                              switch (event.type) {
                              case 'text': trial.firstTextMs ??= elapsed; trial.partialText += event.text; break;
                              case 'reasoning': trial.firstReasoningMs ??= elapsed; trial.partialReasoning += event.text; break;
                              default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
                              }
                              break;
                            }
                            case 'tool_call_start': case 'tool_call_draft': case 'tool_call': break;
                            default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
                            }
                          // The view samples current at a low rate. No reactive full
                          // result replacement or awaited UI work on each delivery.
                          },
                        });
                        local.signal.throwIfAborted();
                        trial.status = 'succeeded';
                      } catch (error) {
                        trial.status = control.signal.aborted ? 'cancelled' : 'failed';
                        trial.error = timedOut ? 'trial-timeout' : errorCode({ error });
                        trial.exclusion.push('failed');
                        throw error;
                      } finally {
                        accepting = false; clearTimeout(timer);
                        for (const signal of sources) signal.removeEventListener('abort', abort);
                        trial.elapsedMs = Math.max(0, now() - started);
                        trial.hiddenObserved ||= hidden();
                        if (trial.hiddenObserved) trial.exclusion.push('page-hidden');
                        if (observation !== undefined) trial.exclusion.push('instrumented');
                        const metrics = trial.summary?.performance;
                        switch (observation) {
                        case 'placement': {
                          const census = metrics?.backendCensus;
                          if (!census?.observedNodes) trial.warnings.push('placement-missing');
                          const capability = census?.capability;
                          switch (capability) {
                          case 'tensor-layout-only': trial.warnings.push('placement-layout-only'); break;
                          case 'legacy-synchronous-getters': case 'synchronous-leaf-bindings-v1': case undefined: break;
                          default: { const exhaustive: never = capability; void exhaustive; }
                          }
                          if (census && (census.errors > 0 || census.droppedNodes > 0)) trial.warnings.push('placement-incomplete');
                          break;
                        }
                        case undefined: break;
                        default: { const exhaustive: never = observation; void exhaustive; }
                        }
                        if (!metrics) trial.exclusion.push('missing-summary');
                        else {
                          switch (metrics.outcome) {
                          case 'completed': break;
                          case 'aborted': case 'failed': trial.exclusion.push('incomplete-summary'); break;
                          default: { const exhaustive: never = metrics.outcome; void exhaustive; }
                          }
                        }
                        if (step.sequence === 'fresh' && metrics?.reusedTokens !== undefined && metrics.reusedTokens !== 0) trial.exclusion.push('unexpected-reuse');
                        if (!trial.output) trial.exclusion.push('incomplete-output');
                        current = undefined; notify();
                      }
                    }
                  } finally {
                    scope.signal.removeEventListener('abort', abortOperation);
                    release = interval({ kind: 'model-release', modelIndex });
                  }
                },
              });
            } catch (error) {
              operationOutcome = control.signal.aborted ? 'cancelled' : 'failed'; throw error;
            } finally {
              if (!entered) acquired({ outcome: operationOutcome });
              // A successful cleanup of a failed request is not inferred here;
              // outcome describes the containing model operation.
              release?.({ outcome: operationOutcome });
            }
          } catch (error) {
            activeSnapshot.modelErrors.push({ modelIndex, error: error instanceof Error ? error.message : String(error) });
            for (const step of steps) if (!activeSnapshot.trials.some(trial => trial.stepId === step.id)) skip({ step, options: plan.options, error: control.signal.aborted ? 'cancelled' : 'model-operation-failed' });
            notify();
          }
        }
      } finally {
        activeSnapshot.status = control.signal.aborted ? 'cancelled' : 'completed';
        for (const step of plan.steps) if (!activeSnapshot.trials.some(trial => trial.stepId === step.id)) skip({ step, options: plan.options, error: 'cancelled' });
        execution.finishedAt = date(); execution.elapsedMs = elapsed();
        current = undefined; controller = undefined; runStarted = undefined; notify();
      }
    },
  };
}

export const TEST_ONLY = {
};
