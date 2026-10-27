import { optionsForLane, performanceLanes } from './plan';
import { nanoid } from 'nanoid';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { type GenerateInput, type RuntimeOptions, errorCode } from '@/features/llama-cpp-browser/types';
import { planSchema, type PerformanceSnapshot, type PerformanceStep, type PerformanceTrial } from './types';
import type { Q8DiagnosticClient } from './q8-diagnostic-worker-types';
import { q8DiagnosticWorkerResultSchema } from './q8-diagnostic-worker-types';
import { q8KernelBenchmarkProgressSchema } from './q8-kernel-schema';

/** No chat store, alternate inference loop, rendering or archive work here. */
export function createPerformanceRunner({ service, now, date, hidden, waitUntilVisible, publish, runKernelDiagnostic }: {
  service: Pick<LlamaCppBrowserService, 'runPerformanceOperation' | 'listModelEntries'>,
  now: () => number, date: () => string, hidden: () => boolean,
  waitUntilVisible: ({ signal }: { signal: AbortSignal }) => Promise<void>,
  publish: ({ snapshot, current }: { snapshot: PerformanceSnapshot, current: PerformanceTrial | undefined }) => void,
  runKernelDiagnostic: Q8DiagnosticClient['run'] | undefined,
}) {
  let controller: AbortController | undefined;
  let snapshot: PerformanceSnapshot | undefined;
  let current: PerformanceTrial | undefined;
  let runStarted: number | undefined;
  // A stale click is bound to an attempt ID, never to whichever request is next.
  let activeAttempt: { trialId: string, started: number, control: AbortController } | undefined;
  const notify = () => {
    if (snapshot) {
      publish({ snapshot, current });
    }
  };
  const skip = ({ step, options, error, skipReason }: { step: PerformanceStep, options: RuntimeOptions, error: string, skipReason?: PerformanceTrial['skipReason'] }): void => {
    snapshot?.trials.push({
      id: nanoid(),
      stepId: step.id,
      modelIndex: step.modelIndex,
      lane: step.lane ?? 'standard',
      status: 'skipped',
      startedAt: date(),
      input: [],
      options,
      partialText: '',
      partialReasoning: '',
      receivedEvents: 0,
      hiddenObserved: hidden(),
      error,
      skipReason,
      warnings: [],
      exclusion: [skipReason ? 'dependency-unavailable' : 'failed'],
    });
  };
  return {
    snapshot: () => snapshot,
    stop(): void {
      controller?.abort();
    },
    canInterruptCurrent({ trialId }: { trialId: string }): boolean {
      return !!activeAttempt && activeAttempt.trialId === trialId && current?.id === trialId && current.status === 'running'
        && !current.interruption && !activeAttempt.control.signal.aborted && !controller?.signal.aborted;
    },
    interruptCurrent({ trialId }: { trialId: string }): boolean {
      const attempt = activeAttempt;
      if (!attempt || attempt.trialId !== trialId || current?.id !== trialId || current.status !== 'running'
        || current.interruption || attempt.control.signal.aborted || controller?.signal.aborted) {
        return false;
      }
      current.interruption = { reason: 'user-skip', requestedMs: Math.max(0, now() - attempt.started), recovery: 'pending' };
      attempt.control.abort();
      notify();
      return true;
    },
    visibilityChanged(): void {
      if (current && hidden()) {
        current.hiddenObserved = true;
      }
      if (snapshot?.q8KernelDiagnostic?.status === 'running' && hidden()) {
        snapshot.q8KernelDiagnostic.hiddenObserved = true;
      }
      if (controller && runStarted !== undefined && snapshot?.execution) {
        const execution = snapshot.execution;
        if (execution.visibility.length < 256) {
          execution.visibility.push({ atMs: Math.max(0, now() - runStarted), hidden: hidden() });
        } else {
          execution.droppedVisibilityEvents++;
        }
      }
      notify();
    },
    async start({ plan: inputPlan, environment }: { plan: PerformanceSnapshot['plan'], environment: PerformanceSnapshot['environment'] }): Promise<void> {
      if (controller) {
        throw new Error('Measurement already running');
      }
      const plan = planSchema.parse(inputPlan);
      const control = new AbortController();
      controller = control;
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
      const interval = ({ kind, modelIndex, stepId, lane, runtimeSegment }: { kind: typeof execution.intervals[number]['kind'], modelIndex: number, stepId?: string, lane?: PerformanceStep['lane'], runtimeSegment?: number }) => {
        const start = elapsed(), hiddenAtStart = hidden();
        return ({ outcome }: { outcome: typeof execution.intervals[number]['outcome'] }) => {
          execution.intervals.push({ kind, modelIndex, stepId, lane, runtimeSegment, startedMs: start, elapsedMs: Math.max(0, elapsed() - start), hiddenAtStart, outcome });
        };
      };
      const visible = async ({ modelIndex, stepId, lane, runtimeSegment }: { modelIndex: number, stepId?: string, lane?: PerformanceStep['lane'], runtimeSegment?: number }) => {
        const finish = interval({ kind: 'visibility-wait', modelIndex, stepId, lane, runtimeSegment });
        let outcome: typeof execution.intervals[number]['outcome'] = 'completed';
        try {
          await waitUntilVisible({ signal: control.signal });
        } catch (error) {
          outcome = control.signal.aborted ? 'cancelled' : 'failed';
          throw error;
        } finally {
          finish({ outcome });
        }
      };
      snapshot = { plan, environment, status: 'running', trials: [], modelErrors: [], execution };
      const activeSnapshot = snapshot;
      notify();
      try {
        for (const { modelIndex, model, lane } of plan.models.flatMap((model, modelIndex) => performanceLanes({ mode: plan.settings.mode }).map(lane => ({ modelIndex, model, lane })))) {
          if (control.signal.aborted) {
            break;
          }
          const steps = plan.steps.filter(step => step.modelIndex === modelIndex && (step.lane ?? 'standard') === lane);
          const options = optionsForLane({ plan, lane });
          let runtimeSegment = 0;
          let remaining = steps;
          let resuming: PerformanceTrial | undefined;
          // Never call generate again on a failed scope. Recovery re-enters the
          // existing service only AFTER it retires the Worker and releases its lane.
          while (remaining.length && !control.signal.aborted) {
            let interrupted: PerformanceTrial | undefined;
            try {
              await visible({ modelIndex, lane, runtimeSegment });
              control.signal.throwIfAborted();
              const inventory = interval({ kind: 'model-inventory', modelIndex, lane, runtimeSegment });
              const stored = await service.listModelEntries({ signal: control.signal }).then(value => {
                inventory({ outcome: 'completed' });
                return value;
              }, error => {
                inventory({ outcome: control.signal.aborted ? 'cancelled' : 'failed' });
                throw error;
              });
              control.signal.throwIfAborted();
              const matching = stored.filter(entry => entry.modelId === model.modelId);
              if (matching.length !== 1 || matching[0]?.size !== model.size || matching[0]?.importedAt !== model.importedAt) {
                throw new Error('Selected model inventory changed');
              }
              const acquired = interval({ kind: 'model-acquire', modelIndex, lane, runtimeSegment });
              let entered = false;
              let release: ReturnType<typeof interval> | undefined;
              let operationOutcome: typeof execution.intervals[number]['outcome'] = 'completed';
              try {
                await service.runPerformanceOperation({
                  options,
                  signal: control.signal,
                  operation: async ({ scope }) => {
                    entered = true;
                    acquired({ outcome: 'completed' });
                    if (resuming?.interruption) {
                      resuming.interruption.recovery = 'new-scope';
                      resuming = undefined;
                    }
                    let firstInScope = true;
                    // Service cancellation must also interrupt visibility waits, not
                    // only a currently running native call. Detach before the service
                    // aborts its scope during ordinary end-of-model cleanup.
                    const abortOperation = () => control.abort();
                    scope.signal.addEventListener('abort', abortOperation, { once: true });
                    if (scope.signal.aborted) {
                      abortOperation();
                    }
                    try {
                      for (const step of remaining) {
                        if (control.signal.aborted) {
                          break;
                        }
                        await visible({ modelIndex, stepId: step.id, lane, runtimeSegment });
                        control.signal.throwIfAborted();
                        const parent = step.dependsOn === undefined ? undefined : activeSnapshot.trials.find(trial => trial.stepId === step.dependsOn);
                        if (step.dependsOn !== undefined && (parent?.status !== 'succeeded' || (parent.runtimeSegment ?? 0) !== runtimeSegment || !parent.output || parent.output.toolCalls.length || (!parent.output.content && !parent.output.reasoningContent))) {
                          skip({ step, options: scope.options, error: 'Continuation preparation did not produce a usable response in this runtime segment', skipReason: parent?.status === 'succeeded' && (parent.runtimeSegment ?? 0) !== runtimeSegment ? 'dependency-runtime-reset' : undefined });
                          notify();
                          continue;
                        }
                        const messages: PerformanceTrial['input'] = parent?.output
                          ? [...parent.input, { role: 'assistant', content: parent.output.content, reasoning_content: parent.output.reasoningContent }, { role: 'user', content: step.prompt }]
                          : [{ role: 'user', content: step.prompt }];
                        const trial: PerformanceTrial = {
                          id: nanoid(),
                          stepId: step.id,
                          modelIndex,
                          lane,
                          status: 'running',
                          runtimeSegment,
                          startedAt: date(),
                          startedMs: elapsed(),
                          input: messages,
                          options: { ...scope.options },
                          partialText: '',
                          partialReasoning: '',
                          receivedEvents: 0,
                          hiddenObserved: hidden() || Boolean(parent?.hiddenObserved),
                          warnings: runtimeSegment > 0 && firstInScope ? ['runtime-restarted'] : [],
                          exclusion: [],
                        };
                        if (parent?.output?.finishReason !== undefined && parent.output.finishReason !== 'stop') {
                          trial.warnings.push('incomplete-parent');
                        }
                        firstInScope = false;
                        activeSnapshot.trials.push(trial);
                        current = trial;
                        const started = now();
                        let lastDelivery: number | undefined;
                        let accepting = true;
                        let timedOut = false;
                        const local = new AbortController();
                        const abort = () => local.abort();
                        const sources = [...new Set([control.signal, scope.signal])];
                        for (const signal of sources) {
                          signal.addEventListener('abort', abort, { once: true });
                          if (signal.aborted) {
                            abort();
                          }
                        }
                        const timer = setTimeout(() => {
                          if (!local.signal.aborted) {
                            timedOut = true;
                            local.abort();
                            notify();
                          }
                        }, plan.settings.timeoutMs);
                        const observation = (() => {
                          switch (step.scenario) {
                          case 'placement': return 'placement' as const;
                          case 'initial': case 'short': case 'long': case 'continuation': return undefined;
                          default: {
                            const exhaustive: never = step.scenario;
                            throw new Error(String(exhaustive));
                          }
                          }
                        })();
                        const input: Omit<GenerateInput, 'options'> = {
                          modelId: model.modelId,
                          messages,
                          debug: 'off',
                          temperature: 0,
                          topP: 1,
                          maxTokens: step.maxTokens,
                          presencePenalty: 0,
                          frequencyPenalty: 0,
                          stop: [],
                        };
                        activeAttempt = { trialId: trial.id, started, control: local };
                        try {
                          notify();
                          // The first publish may already request interruption.
                          local.signal.throwIfAborted();
                          trial.output = await scope.generate({
                            input,
                            sequence: step.sequence,
                            observation,
                            signal: local.signal,
                            onProgress: ({ progress }) => {
                              if (!accepting) {
                                return;
                              }
                              trial.lastProgress = { ...progress };
                              trial.lastProgressMs = Math.max(0, now() - started);
                            },
                            onMemoryDiagnostics: ({ memory }) => {
                              if (accepting) {
                                trial.memoryDiagnostics = memory;
                              }
                            },
                            onSummary: ({ diagnostic }) => {
                              if (accepting) {
                                trial.summary = diagnostic;
                              }
                            },
                            onEvent: ({ event }) => {
                              if (!accepting) {
                                return;
                              }
                              const elapsed = Math.max(0, now() - started);
                              trial.receivedEvents++;
                              switch (event.type) {
                              case 'text': case 'reasoning': {
                                if (!event.text.length) {
                                  return;
                                }
                                trial.firstReceivedMs ??= elapsed;
                                if (lastDelivery !== undefined) {
                                  trial.maximumDeliveryGapMs = Math.max(trial.maximumDeliveryGapMs ?? 0, elapsed - lastDelivery);
                                }
                                lastDelivery = elapsed;
                                switch (event.type) {
                                case 'text': trial.firstTextMs ??= elapsed;
                                  trial.partialText += event.text;
                                  break;
                                case 'reasoning': trial.firstReasoningMs ??= elapsed;
                                  trial.partialReasoning += event.text;
                                  break;
                                default: {
                                  const exhaustive: never = event;
                                  throw new Error(String(exhaustive));
                                }
                                }
                                break;
                              }
                              case 'generation_metrics': case 'tool_call_start': case 'tool_call_draft': case 'tool_call': break;
                              default: {
                                const exhaustive: never = event;
                                throw new Error(String(exhaustive));
                              }
                              }
                            // The view samples current at a low rate. No reactive full
                            // result replacement or awaited UI work on each delivery.
                            },
                          });
                          local.signal.throwIfAborted();
                          trial.status = 'succeeded';
                        } catch (error) {
                          trial.status = control.signal.aborted ? 'cancelled' : trial.interruption ? 'interrupted' : 'failed';
                          trial.error = timedOut ? 'trial-timeout' : errorCode({ error });
                          if (trial.interruption) {
                            interrupted = trial;
                            trial.exclusion.push('interrupted');
                          } else {
                            trial.exclusion.push('failed');
                          }
                          throw error;
                        } finally {
                          accepting = false;
                          clearTimeout(timer);
                          for (const signal of sources) {
                            signal.removeEventListener('abort', abort);
                          }
                          trial.elapsedMs = Math.max(0, now() - started);
                          if (trial.interruption) {
                            trial.interruption.settledMs = trial.elapsedMs;
                          }
                          trial.hiddenObserved ||= hidden();
                          if (trial.hiddenObserved) {
                            trial.exclusion.push('page-hidden');
                          }
                          if (observation !== undefined || lane === 'gpu-profile') {
                            trial.exclusion.push('instrumented');
                          }
                          const metrics = trial.summary?.performance;
                          const gpuStatus = metrics?.gpuProfile?.status;
                          switch (lane) {
                          case 'standard': break;
                          case 'gpu-profile':
                            switch (gpuStatus) {
                            case undefined: case 'unavailable': trial.warnings.push('gpu-profile-missing');
                              break;
                            case 'partial': trial.warnings.push('gpu-profile-incomplete');
                              break;
                            case 'complete': break;
                            default: {
                              const exhaustive: never = gpuStatus;
                              void exhaustive;
                            }
                            }
                            break;
                          default: {
                            const exhaustive: never = lane;
                            void exhaustive;
                          }
                          }
                          switch (observation) {
                          case 'placement': {
                            const census = metrics?.backendCensus;
                            if (!census?.observedNodes) {
                              trial.warnings.push('placement-missing');
                            }
                            const capability = census?.capability;
                            switch (capability) {
                            case 'tensor-layout-only': trial.warnings.push('placement-layout-only');
                              break;
                            case 'legacy-synchronous-getters': case 'synchronous-leaf-bindings-v1': case undefined: break;
                            default: {
                              const exhaustive: never = capability;
                              void exhaustive;
                            }
                            }
                            const completion = census?.decodeCompletionTiming;
                            if (census && (census.errors > 0 || census.droppedNodes > 0 || completion && (
                              completion.errors > 0 || completion.skippedNodes > 0 || completion.unattributedNodes > 0 ||
                            completion.unfinishedNodes > 0 || completion.timedNodes !== completion.requestedNodes
                            ))) {
                              trial.warnings.push('placement-incomplete');
                            }
                            break;
                          }
                          case undefined: break;
                          default: {
                            const exhaustive: never = observation;
                            void exhaustive;
                          }
                          }
                          if (!metrics) {
                            trial.exclusion.push('missing-summary');
                          } else {
                            switch (metrics.outcome) {
                            case 'completed': break;
                            case 'aborted': case 'failed': trial.exclusion.push('incomplete-summary');
                              break;
                            default: {
                              const exhaustive: never = metrics.outcome;
                              void exhaustive;
                            }
                            }
                          }
                          if (step.sequence === 'fresh' && metrics?.reusedTokens !== undefined && metrics.reusedTokens !== 0) {
                            trial.exclusion.push('unexpected-reuse');
                          }
                          if (!trial.output) {
                            trial.exclusion.push('incomplete-output');
                          }
                          activeAttempt = undefined;
                          current = undefined;
                          notify();
                        }
                      }
                    } finally {
                      scope.signal.removeEventListener('abort', abortOperation);
                      release = interval({ kind: 'model-release', modelIndex, lane, runtimeSegment });
                    }
                  },
                });
              } catch (error) {
                operationOutcome = control.signal.aborted ? 'cancelled' : interrupted && errorCode({ error }) === 'aborted' ? 'interrupted' : 'failed';
                throw error;
              } finally {
                if (!entered) {
                  acquired({ outcome: operationOutcome });
                }
                // A successful cleanup of a failed request is not inferred here;
                // outcome describes the containing model operation.
                release?.({ outcome: operationOutcome });
              }
              break;
            } catch (error) {
              if (interrupted?.interruption && !control.signal.aborted && errorCode({ error }) === 'aborted') {
                // An intentional abort is expected. The unchanged service wraps
                // errors, so do not rely on object identity or swallow other errors.
                // Retain dependency skips even if no further scope is necessary.
                for (const step of steps) {
                  if (activeSnapshot.trials.some(trial => trial.stepId === step.id) || !step.dependsOn) {
                    continue;
                  }
                  const parent = activeSnapshot.trials.find(trial => trial.stepId === step.dependsOn);
                  if (parent?.status === 'interrupted' || parent?.skipReason === 'dependency-interrupted') {
                    skip({ step, options, error: 'Dependency was interrupted by the user', skipReason: 'dependency-interrupted' });
                  }
                }
                remaining = steps.filter(step => !activeSnapshot.trials.some(trial => trial.stepId === step.id));
                if (remaining.length) {
                  resuming = interrupted;
                  runtimeSegment++;
                  notify();
                  continue;
                }
                interrupted.interruption.recovery = 'not-needed';
                notify();
                break;
              }
              for (const trial of [interrupted, resuming]) {
                if (trial?.interruption) {
                  trial.interruption.recovery = control.signal.aborted ? 'stopped' : 'failed';
                }
              }
              activeSnapshot.modelErrors.push({ modelIndex, lane, error: error instanceof Error ? error.message : String(error) });
              for (const step of steps) {
                if (!activeSnapshot.trials.some(trial => trial.stepId === step.id)) {
                  skip({ step, options, error: control.signal.aborted ? 'cancelled' : 'model-operation-failed' });
                }
              }
              notify();
              break;
            }
          }
          if (resuming?.interruption && resuming.interruption.recovery === 'pending') {
            resuming.interruption.recovery = 'stopped';
          }
        }
        if (runKernelDiagnostic && !control.signal.aborted && performanceLanes({ mode: plan.settings.mode }).includes('gpu-profile')) {
          const diagnostic: NonNullable<PerformanceSnapshot['q8KernelDiagnostic']> = { status: 'running', startedMs: elapsed(), hiddenObserved: hidden() };
          activeSnapshot.q8KernelDiagnostic = diagnostic;
          notify();
          try {
            await waitUntilVisible({ signal: control.signal });
            control.signal.throwIfAborted();
            // The existing service owns exclusion and global cancellation. This
            // callback uses no model, generation request or synthetic model ID.
            await service.runPerformanceOperation({
              options: optionsForLane({ plan, lane: 'gpu-profile' }),
              signal: control.signal,
              operation: async ({ scope }) => {
                const abort = () => control.abort();
                scope.signal.addEventListener('abort', abort, { once: true });
                if (scope.signal.aborted) {
                  abort();
                }
                try {
                  scope.signal.throwIfAborted();
                  diagnostic.result = q8DiagnosticWorkerResultSchema.parse(await runKernelDiagnostic({
                    signal: scope.signal,
                    timeoutMs: Math.min(plan.settings.timeoutMs, 120000),
                    onProgress: ({ progress }) => {
                      if (diagnostic.status !== 'running' || control.signal.aborted) {
                        return;
                      }
                      diagnostic.progress = q8KernelBenchmarkProgressSchema.parse(progress);
                      diagnostic.hiddenObserved ||= hidden();
                      notify();
                    },
                  }));
                  control.signal.throwIfAborted();
                  diagnostic.status = diagnostic.result.status;
                } catch (error) {
                  // Retain the diagnostic cause before the service translates
                  // failures to its public error code.
                  diagnostic.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
                  throw error;
                } finally {
                  scope.signal.removeEventListener('abort', abort);
                }
              },
            });
          } catch (error) {
            const code = errorCode({ error });
            switch (code) {
            case 'aborted': control.abort();
              break;
            case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
            case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full': case 'unsupported-input':
            case 'busy': case 'worker-failed': case 'audio-model-unsupported': case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty': break;
            default: {
              const exhaustive: never = code;
              throw new Error(`Unhandled diagnostic error code: ${exhaustive}`);
            }
            }
            diagnostic.status = control.signal.aborted ? 'cancelled' : 'failed';
            diagnostic.error ??= (error instanceof Error ? error.message : String(error)).slice(0, 1000);
          } finally {
            diagnostic.elapsedMs = Math.max(0, elapsed() - diagnostic.startedMs);
            diagnostic.hiddenObserved ||= hidden();
            notify();
          }
        }
      } finally {
        activeSnapshot.status = control.signal.aborted ? 'cancelled' : 'completed';
        for (const step of plan.steps) {
          if (!activeSnapshot.trials.some(trial => trial.stepId === step.id)) {
            skip({ step, options: optionsForLane({ plan, lane: step.lane ?? 'standard' }), error: 'cancelled' });
          }
        }
        execution.finishedAt = date();
        execution.elapsedMs = elapsed();
        activeAttempt = undefined;
        current = undefined;
        controller = undefined;
        runStarted = undefined;
        notify();
      }
    },
  };
}

export const TEST_ONLY = {
};
