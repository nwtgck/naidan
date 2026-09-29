import type { ImageDiagnosticInput, createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { MeasurementPoint, MeasurementOutcome } from './gpu-performance';
export type PerformancePhase = 'runtime' | 'model-header' | 'model-load' | 'prepare' | 'conditioning' | 'sampling' | 'decoding' | 'encoding' | 'cleanup';
export type NativePerformanceSignal = { kind: 'conditioning' } | { kind: 'sampling-progress', step: number, steps: number };
const emptyPhases = () => ({ runtime: 0, 'model-header': 0, 'model-load': 0, prepare: 0, conditioning: 0, sampling: 0, decoding: 0, encoding: 0, cleanup: 0 });

/** Bounded per-run wall timeline. Only the REAL native progress callback starts
 * denoising; the earlier UI step=0 also includes text conditioning. Native log
 * summaries below are independently reported (rounded) clocks, not disjoint
 * spans to add to this timeline. No arbitrary log text is retained or emitted. */
export function createRunPerformance({ enabled, request, emit, checkpoint, now = () => performance.now() }: {
  enabled: boolean, request: Request, emit: ReturnType<typeof createImageTrace>['emit'],
  checkpoint: ({ point }: { point: MeasurementPoint }) => void, now?: () => number,
}) {
  const began = enabled ? now() : 0;
  let phase: PerformancePhase = 'runtime', phaseStart = began, closed = false;
  let step = 0, stepsSeen = 0, stepStart: number | undefined, stepSum = 0, stepMin = Infinity, stepMax = 0;
  const phases = emptyPhases();
  let conditionReports = 0, samplingReports = 0, finalDecodeReports = 0;
  let conditionMs = 0, samplingMs = 0, finalDecodeMs = 0, previewMs = 0, previewReports = 0, stepPreviewMs = 0;
  let diffusionGraphs = 0, textGraphs = 0, vaeGraphs = 0, otherGraphs = 0;
  function report({ metric, fields }: { metric: string, fields: ImageDiagnosticInput['fields'] }): void {
    if (!enabled || closed) return;
    try {
      emit({ event: 'native', stage: 'generation', message: undefined, fields: { metric, perfVersion: 1, ...fields } });
    } catch { /* observational */ }
  }
  function setPhase({ next }: { next: PerformancePhase }): void {
    if (!enabled || closed || next === phase) return;
    const time = now(), ms = Math.max(0, time - phaseStart);
    phases[phase] += ms;
    report({ metric: 'phase-wall', fields: { phase, milliseconds: ms, startMs: phaseStart - began, endMs: time - began } });
    checkpoint({ point: { phase: next, step: (() => {
      switch (next) {
      case 'sampling': return step;
      case 'runtime': case 'model-header': case 'model-load': case 'prepare': case 'conditioning': case 'decoding': case 'encoding': case 'cleanup': return 0;
      default: { const exhaustive: never = next; throw new Error(String(exhaustive)); }
      }
    })(), reason: 'phase' } });
    phase = next; phaseStart = time;
  }
  return {
    settings(): void {
      if (!enabled || closed) return;
      const p = request.parameters;
      // Exact approved flag only; do not parse/export arbitrary model arguments.
      const arg = p.modelArguments.trim();
      const cacheFlag = /^qwen_image_2_1_prefix_cache=(true|false)$/.exec(arg)?.[1];
      report({ metric: 'run-settings', fields: { appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.slice(0, 128) : 'not-available',
        previewStartStep: request.preview.startStep, previewMaxEdge: request.preview.maxEdge,
        conditioningCacheSize: p.conditioningCacheSize, qwenVaePolicy: p.qwenVaePolicy, distilledGuidance: p.distilledGuidance,
        modelArgumentsPresent: !!arg, qwenPrefixCacheRequested: cacheFlag ?? (arg ? 'not-disclosed' : 'native-default'),
        modelBytes: request.models.reduce((n, model) => n + model.file.size + (model.companions ?? []).reduce((a, c) => a + c.file.size, 0), 0),
        gpuTimestampMeasured: false, semanticBackendTrace: false, previewNativeTime: 'rounded-native-log-when-available' } });
      if (typeof navigator !== 'undefined') {
        const match = /(?:Chrome|Chromium|Firefox)\/(\d+(?:\.\d+){0,3})/.exec(navigator.userAgent ?? '');
        report({ metric: 'run-environment', fields: { browserVersion: match?.[0] ?? 'not-disclosed',
          hardwareConcurrency: navigator.hardwareConcurrency ?? 0 } });
      }
    },
    phase: setPhase,
    native({ signal }: { signal: NativePerformanceSignal }): void {
      if (!enabled || closed) return;
      switch (signal.kind) {
      case 'conditioning': setPhase({ next: 'conditioning' }); return;
      case 'sampling-progress': break;
      default: { const exhaustive: never = signal; throw new Error(String(exhaustive)); }
      }
      const { step: next, steps } = signal;
      if (!Number.isInteger(next) || steps !== request.parameters.steps || next < 0 || next > steps) return;
      if (next === 0 && stepStart === undefined) {
        setPhase({ next: 'sampling' }); stepStart = now(); return;
      }
      if (stepStart === undefined || next <= step) return;
      const time = now(), ms = Math.max(0, time - stepStart);
      stepSum += ms; stepMin = Math.min(stepMin, ms); stepMax = Math.max(stepMax, ms); stepsSeen++;
      report({ metric: 'step-wall', fields: { step: next, previousStep: step, steps, milliseconds: ms,
        includesPreviewWork: true, previewReportedMs: previewMs - stepPreviewMs } });
      checkpoint({ point: { phase: 'sampling', step: next, reason: 'completed-step' } });
      step = next; stepStart = time; stepPreviewMs = previewMs;
    },
    log({ message }: { message: string }): void {
      if (!enabled || closed || message.length > 2048) return;
      // Anchored, pinned diagnostic formats. Changes in upstream remain missing
      // information, never guessed timings or disclosure of prompt/model text.
      let value: RegExpExecArray | null;
      if ((value = /^image\.cpp:\d+\s+- get_learned_condition completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        conditionMs += Number(value[1]) * 1000; conditionReports++;
      }
      if ((value = /^image\.cpp:\d+\s+- sampling completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        samplingMs += Number(value[1]) * 1000; samplingReports++;
      }
      if ((value = /^vae\.hpp:\d+\s+- computing vae decode graph completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        switch (phase) {
        case 'sampling': previewMs += Number(value[1]) * 1000; previewReports++; break;
        case 'decoding': finalDecodeMs += Number(value[1]) * 1000; finalDecodeReports++; break;
        case 'runtime': case 'model-header': case 'model-load': case 'prepare': case 'conditioning': case 'encoding': case 'cleanup': break;
        default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
        }
      }
      if ((value = /^ggml_runner\.cpp:\d+\s+- ([a-z0-9_]+) executing segment \d+\/\d+: graph\s*$/.exec(message))) {
        const name = value[1];
        if (name === 'z_image' || name === 'qwen_image_2_1') diffusionGraphs++;
        else if (name === 'qwen3' || name === 'qwen3vl') textGraphs++;
        else if (name === 'vae' || name === 'wan_vae') vaeGraphs++;
        else otherGraphs++;
      }
    },
    preview({ fields }: { fields: ImageDiagnosticInput['fields'] }): void {
      report({ metric: 'preview-output', fields });
    },
    finish({ outcome }: { outcome: MeasurementOutcome }): void {
      if (!enabled || closed) return;
      const time = now();
      phases[phase] += Math.max(0, time - phaseStart);
      const partialStepWallMs = phase === 'sampling' && stepStart !== undefined && step < request.parameters.steps ? Math.max(0, time - stepStart) : 0;
      report({ metric: 'run-wall', fields: { outcome, milliseconds: Math.max(0, time - began), ...phases,
        partialStepWallMs,
        completedStepIntervals: stepsSeen, stepWallSumMs: stepSum, stepMinMs: stepsSeen ? stepMin : 0, stepMaxMs: stepMax,
        nativeConditionMs: conditionMs, nativeConditionReports: conditionReports, nativeSamplingMs: samplingMs, nativeSamplingReports: samplingReports,
        nativeFinalDecodeMs: finalDecodeMs, nativeFinalDecodeReports: finalDecodeReports,
        nativePreviewDecodeMs: previewMs, nativePreviewDecodeReports: previewReports,
        diffusionGraphStarts: diffusionGraphs, textGraphStarts: textGraphs, vaeGraphStarts: vaeGraphs, otherGraphStarts: otherGraphs,
        nativeTimesOverlapWall: true, nativeTimesAreRounded: true } });
      closed = true;
    },
  };
}
export const TEST_ONLY = {
};
